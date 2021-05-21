/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * Shared workflow tasks for dealing with fabrics
 */

var async = require('async');


/*
 * # Fabric NAT zones: a primer
 *
 * ## General
 *
 * Fabric networks are virtual private networks - they are entirely controlled
 * by SDC.  This means that they don't rely on routers or any sort of hardware
 * networking devices: if we want VMs on a fabric to have external (internet)
 * access, they must either have an external nic or the fabric network needs
 * to have another VM on it to do Network Address Translation (NAT).
 *
 * By default, every SDC user in a datacenter gets a default fabric network
 * (and can create up to 1000 of them).  We don't want a NAT zone to be
 * provisioned if there are no VMs on the same network that could potentially
 * use it: we'd have a running VM for no reason.  Instead, we provision NAT
 * zones on demand: the various VMAPI workflows determine if a network doesn't
 * have a NAT zone yet and provision one on behalf of the user.
 *
 * When a VM has an associated NAT zone, when the last NIC in that fabric
 * network is deleted, then the corresponding NAT zone will also be deleted,
 * so that there are no unused NAT zones hanging around.
 *
 * ## VMAPI Implementation
 *
 * In VMAPI, there are three different components to NAT zone provisioning
 *
 * 1) Ticket acquisition and VM provisioning
 * 2) Waiting for provisions
 * 3) Releasing tickets
 *
 * Each fabric network is guarded by a CNAPI waitlist ticket to prevent many
 * concurrent provisions from provisioning the same NAT zone (resulting in
 * needless failed provisions).  Once that ticket is obtained, we can then
 * check if some other job that was holding the ticket provisioned the NAT
 * zone for us.  If not, we call out to SAPI to provision us a NAT zone.
 *
 * Note that we try to kick off this provision as quickly as possible in
 * the workflow, to try and minimize the amount of time we have to wait for
 * it.  We must wait for the provision to complete before actually sending
 * the provision to CNAPI, though, since the zone's startup scripts may
 * require internet access.
 *
 * Releasing tickets is a bit trickier, since a workflow can potentially
 * fail before it reaches the waiting for NAT provisions section.  Therefore,
 * the NAT provision job itself is responsible for releasing its own ticket.
 * If we fail before SAPI returns a successful provision, then the calling
 * job can release the ticket, since the NAT provision job never actually
 * got kicked off.
 */


/*
 * If there are fabric NATs that need provisioning/destroying, obtain a ticket
 * for each of them.
 */
function acquireFabricTickets(job, cb) {
    if (!job.params.fabricNatNics || job.params.fabricNatNics.length === 0) {
        return cb(null, 'No fabric NICs');
    }

    var cnapi = new sdcClients.CNAPI({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });
    var nics = [];
    var netuuids = [];

    job.params.fabricNatTickets = [];

    // Uniquify, just in case
    for (var n in job.params.fabricNatNics) {
        if (netuuids.indexOf(job.params.fabricNatNics[n].network_uuid) === -1) {
            nics.push(job.params.fabricNatNics[n]);
            netuuids.push(job.params.fabricNatNics[n].network_uuid);
        }
    }

    async.mapSeries(nics, function (nic, next) {
        var newTicket = {
            scope: 'fabric_nat',
            id: nic.network_uuid,
            expires_at: (new Date(
                Date.now() + 600 * 1000).toISOString())
        };

        cnapi.waitlistTicketCreate('default', newTicket, onCreate);

        function onCreate(err, ticket) {
            if (err) {
                next(err);
                return;
            }

            // look up ticket, ensure it's not expired or invalid
            cnapi.waitlistTicketGet(ticket.uuid,
                function (geterr, getticket) {
                    if (geterr) {
                        next(geterr);
                        return;
                    }

                    job.params.fabricNatTickets.push({
                        nic: nic,
                        ticket: getticket
                    });
                    job.log.info(
                        { nic: nic, ticket: getticket },
                        'ticket status after create');
                    next();
                });
        }
    }, function (sErr) {
        if (sErr) {
            cb(sErr);
        } else {
            cb(null, 'Fabric NAT tickets acquired');
        }
    });
}


/*
 * Wait for any tickets obtained in acquireFabricTickets(), then:
 * - Check if another workflow holding the ticket has already provisioned
 *   the NAT
 * - If not, kick off the provision ourselves
 */
function provisionFabricNats(job, cb) {
    if (!job.params.fabricNatTickets ||
            job.params.fabricNatTickets.length === 0) {
        return cb(null, 'No fabric NATs to provision');
    }

    if (!job.params.sdc_nat_pool) {
        return cb(new Error('No fabric NAT pool configured for provisioning'));
    }

    var cnapi = new sdcClients.CNAPI({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });
    var napi = new sdcClients.NAPI({
        url: napiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });
    var natSvc;
    var sapi = new sdcClients.SAPI({
        log: job.log.child({ component: 'sapi' }),
        url: sapiUrl,
        version: '~2',
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    function releaseTicket(tErr, ticket, tCb) {
        cnapi.waitlistTicketRelease(ticket.uuid, function (relErr) {
            if (relErr) {
                job.log.error({ ticket: ticket, err: relErr },
                    'Error releasing ticket');
            }

            if (tErr) {
                tCb(tErr);
                return;
            }

            tCb(relErr);
            return;
        });
    }

    /*
     * Provision a new NAT zone through SAPI on two networks:
     * - the configured NAT network pool
     * - the fabric network that needs a NAT zone
     */
    function provisionNatZone(tick, done) {
        var fabricNic = tick.nic;

        // If we were waiting on a ticket because another NAT zone was being
        // provisioned and it succeeded, we don't need to provision another.
        napi.getNetwork(fabricNic.network_uuid, function (netErr, fNet) {
            if (netErr) {
                return done(netErr);
            }

            if (fNet.gateway_provisioned) {
                job.log.debug({ ticket: tick.ticket.uuid, net: fNet },
                    'Network already has gateway provisioned');
                tick.gateway_provisioned = true;
                return releaseTicket(null, tick.ticket, done);
            }

            var instParams = {
                metadata: {
                    'com.joyent:ipnat_subnet': fNet.subnet
                },
                params: {
                    alias: 'nat-' + fabricNic.network_uuid,
                    internal_metadata: {
                        'com.joyent:ipnat_owner': job.params.owner_uuid
                    },
                    networks: [
                        {
                            uuid: job.params.sdc_nat_pool,
                            primary: true,
                            allow_ip_spoofing: true
                        },
                        {
                            uuid: fabricNic.network_uuid,
                            ip: fabricNic.gateway,
                            allow_ip_spoofing: true
                        }
                    ],
                    ticket: tick.ticket.uuid
                }
            };
            
            /* If the request says to place the VM on an encrypted CN then also place the NAT
             * zone on an encrypted CN. This is necessary when all CNs are encrypted. 
             * If the user doesn't want the NAT zone on an encrypted CN then they can first create 
             * a VM without encryption to get the NAT zone placed on an unencrypted CN then create
             * another VM with encryption since the NAT zone will have already been created.
             */
            if (job.params.internal_metadata && job.params.internal_metadata.encrypted === true) {
                instParams.params.internal_metadata.encrypted = true;
            }

            sapi.createInstanceAsync(natSvc, instParams,
                    function _afterSapiProv(createErr, inst) {
                if (createErr) {
                    return releaseTicket(createErr, tick.ticket, done);
                }

                job.log.info({ instance: inst, natSvc: natSvc },
                    'Created NAT instance');

                tick.job_uuid = inst.job_uuid;
                tick.vm_uuid = inst.uuid;
                return done();
            });
        });
    }

    sapi.listServices({ name: 'nat' }, function (sapiErr, svcs) {
        if (sapiErr) {
            return cb(sapiErr);
        }

        if (!svcs || svcs.length === 0) {
            return cb(new Error('No "nat" service found in SAPI'));
        }

        if (svcs.length > 1) {
            return cb(new Error('More than one "nat" service found in SAPI'));
        }

        natSvc = svcs[0].uuid;
        job.log.info({ svc: natSvc, svcs: svcs }, 'svcs');

        async.forEach(job.params.fabricNatTickets, function (tick, next) {
            if (tick.ticket.status === 'active') {
                return provisionNatZone(tick, next);
            }

            cnapi.waitlistTicketWait(tick.ticket.uuid,
                    function _afterWait(tErr) {
                if (tErr) {
                    next(tErr);
                } else {
                    provisionNatZone(tick, next);
                }
            });

        }, function (aErr) {
            if (aErr) {
                cb(aErr);
            } else {
                cb(null, 'Provisioned fabric NATs');
            }
        });
    });
}


/*
 * Wait for any pending fabric NAT provisions to complete.
 */
function waitForFabricNatProvisions(job, cb) {
    if (!job.params.fabricNatTickets ||
            job.params.fabricNatTickets.length === 0) {
        return cb(null, 'No fabric NATs provisioned');
    }

    // Filter out tickets that didn't end up needing a gateway provisioned
    var toWaitFor = job.params.fabricNatTickets.filter(function (t) {
        return !t.gateway_provisioned;
    });

    if (toWaitFor.length === 0) {
        return cb(null, 'No fabric NAT provisions left to wait for');
    }

    var vmapi = new sdcClients.VMAPI({
        url: vmapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    function checkVm(tick, done) {
        var uuid = tick.vm_uuid;
        vmapi.getVm({ uuid: uuid }, onVmapi);

        function onVmapi(err, vm, req, res) {
            if (err) {
                cb(err);

            } else if (vm.state === 'running') {
                done();

            } else if (vm.state === 'failed') {
                done(new Error(
                        'NAT zone "' + vm.uuid + '" failed to provision'));

            } else {
                setTimeout(checkVm, 1000, tick, done);
            }
        }
    }

    async.forEach(toWaitFor, checkVm, function (aErr) {
        if (aErr) {
            cb(aErr);
        } else {
            cb(null, 'Fabric NATs running');
        }
    });
}


/*
 * Get information on the vm NIC's to see if any are fabric NICs.
 */
function getFabricNatNics(job, cb) {
    if (!job.currentVm) {
        cb(null, 'Skipping task -- VM missing from job');
        return;
    }

    if (!job.currentVm.nics || !Array.isArray(job.currentVm.nics)) {
        cb(null, 'Skipping task -- VM is missing .nics');
        return;
    }

    var napi = new sdcClients.NAPI({
        url: napiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    var vmNics = job.currentVm.nics.filter(function _filterNics(nic) {
        return nic.mac;
    });

    job.params.fabricNatNics = [];

    /*
     * Unfortunately NAPI can return differing error responses, so we use
     * this helper to consolidate the error checking.
     */
    function isNapiResourceNotFoundError(err) {
        if (!err || !err.body) {
            return false;
        }
        if (err.body.code && err.body.code === 'ResourceNotFound') {
            /*
             * Sometimes when NIC doesn't exist, we get 404 and body.code
             * with value 'ResourceNotFound'.
             */
            return true;
        }
        if (err.body.message &&
            err.body.message.match(/^napi_nics::.*does not exist$/)) {
            /*
             * Other times it returns just a 500 and a message like:
             *
             *  'napi_nics::159123443660586 does not exist'
             */
            return true;
        }
        return false;
    }

    async.mapSeries(vmNics, function (vmNic, next) {
        napi.getNic(vmNic.mac, function getNicCb(err, nic) {
            if (err) {
                if (isNapiResourceNotFoundError(err)) {
                    /* No NIC, then nothing to do. */
                    next();
                    return;
                }
                next(err);
                return;
            }

            /*
             * If this is a nic on a fabric, which has a gateway provisioned,
             * and the network uses an internet NAT, add it to the fabricNat
             * list. This fabricNat list will be used later to check whether
             * the provisioned NAT zone is no longer used and thus should be
             * deleted.
             */
            if (nic.fabric && nic.gateway && nic.gateway_provisioned &&
                    nic.ip !== nic.gateway && nic.internet_nat) {
                job.log.debug({nic: nic}, 'found fabric NIC');
                job.params.fabricNatNics.push(nic);
            }
            next();
        });
    }, function (err) {
        if (err) {
            cb(err);
            return;
        }
        cb(null, 'Fabric NIC count: ' + job.params.fabricNatNics.length);
    });
}

/*
 * Wait for any tickets obtained in acquireFabricTickets(), then:
 * 1. Check if this is the last NIC in the associated network, if not, then
 *    there is nothing to do, else proceed to 2.
 * 2. Check if another workflow holding the ticket has already used or destroyed
 *    the NAT, if yes, then there is nothing to do, else proceed to 3.
 * 3. This is the last NIC, kick off the NAT destruction process.
 */
function destroyFabricNats(job, cb) {
    if (!job.params.fabricNatTickets ||
            job.params.fabricNatTickets.length === 0) {
        cb(null, 'No fabric NATs to destroy');
        return;
    }

    var headers = {
        'x-request-id': job.params['x-request-id']
    };
    var cnapi = new sdcClients.CNAPI({
        url: cnapiUrl,
        headers: headers
    });
    var napi = new sdcClients.NAPI({
        url: napiUrl,
        headers: headers
    });

    /* Find the NAT VM and destroy it. */
    function destroyNatZone(fabricNic, done) {
        var listVmParams = {
            alias: 'nat-' + fabricNic.network_uuid,
            state: 'running'
        };
        var vmapi = new sdcClients.VMAPI({
            url: vmapiUrl,
            headers: headers
        });

        vmapi.listVms(listVmParams, function onGetVm(err, vms) {
            var sapi;

            if (err) {
                done(err);
                return;
            }

            if (!vms || vms.length === 0) {
                job.log.debug({ fabricNic: fabricNic },
                    'No NAT vm found for fabric network');
                done();
                return;
            }

            if (!vms.length > 1) {
                job.log.warn({ fabricNic: fabricNic, vms: vms },
                    'Multiple NAT vms found for fabric network - using first');
            }

            job.log.info({ alias: vms[0].alias, zone_uuid: vms[0].uuid },
                'Destroying NAT zone');

            /* Synchronously destroy the NAT vm. */
            sapi = new sdcClients.SAPI({
                url: sapiUrl,
                headers: headers,
                version: '~2',
                log: job.log.child({ component: 'sapi' })
            });
            sapi.deleteInstance(vms[0].uuid, function (dErr) {
                if (dErr && dErr.statusCode !== 404) {
                    done(dErr);
                    return;
                }
                done();
            });
        });
    }

    /*
     * Check whether we should destroy the associated NAT zone.
     */
    function checkDestroyNatZone(tick, done) {
        var fabricNic = tick.nic;

        /* Check if this is the last NIC assigned in the network. */
        napi.listNics({ network_uuid: fabricNic.network_uuid, limit: 5 },
                { headers: headers },
                function (netErr, nics) {
            if (netErr) {
                done(netErr);
                return;
            }

            job.log.info({ nics: nics }, 'listNics result');

            if (!nics || !Array.isArray(nics)) {
                job.log.warn({ fabricNic: fabricNic },
                    'No nics array returned for napi.listNics');
                done(new Error(
                    'Expected array of nics for napi.listNics, got: ' + nics));
                return;
            }

            /*
             * Check if NAT is still used - filter out the NAT gateway nic (as
             * the NAT zone will own one nic on this network that is used as
             * the gateway).
             */
            if (nics.some(function nicFilter(nic) {
                return nic.ip !== nic.gateway;
            })) {
                job.log.debug({ fabricNic: fabricNic },
                    'More nics found on fabric network - nothing to do');
                done();
                return;
            }

            destroyNatZone(fabricNic, done);
        });
    }

    /*
     * Iterate over the NAT tickets, wait for the ticket to become active then
     * check/destroy the associated NAT zone.
     */
    async.forEach(job.params.fabricNatTickets,
            function forEachNatTicket(tick, next) {
        if (tick.ticket.status === 'active') {
            checkDestroyNatZone(tick, next);
            return;
        }

        cnapi.waitlistTicketWait(tick.ticket.uuid, function _afterWait(tErr) {
            if (tErr) {
                next(tErr);
                return;
            }
            checkDestroyNatZone(tick, next);
        });
    }, function (err) {
        if (err) {
            cb(err);
            return;
        }
        cb(null, 'Successful');
    });
}


/*
 * Release all fabric NAT tickets.
 */
function releaseFabricNatTickets(job, cb) {
    if (!job.params.fabricNatTickets ||
            job.params.fabricNatTickets.length === 0) {
        return cb(null, 'No fabric NAT tickets to release');
    }

    var cnapi = new sdcClients.CNAPI({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    async.forEach(job.params.fabricNatTickets, function (tick, next) {
        cnapi.waitlistTicketRelease(tick.ticket.uuid, function (err) {
            if (err && err.code !== 'ResourceNotFound') {
                job.log.warn({ticket: tick.ticket},
                    'Unable to release CNAPI NAT ticket');
                next(err);
                return;
            }
            next();
        });
    }, cb);
}


module.exports = {
    acquireFabricTickets: acquireFabricTickets,
    provisionFabricNats: provisionFabricNats,
    waitForFabricNatProvisions: waitForFabricNatProvisions,

    provisionChain: [
        {
            name: 'cnapi.acquire_fabric_nat_tickets',
            timeout: 10,
            retry: 1,
            body: acquireFabricTickets,
            modules: { sdcClients: 'sdc-clients', async: 'async' }
        },
        {
            name: 'napi.provision_fabric_nats',
            timeout: 120,
            retry: 1,
            body: provisionFabricNats,
            modules: { sdcClients: 'sdc-clients', async: 'async' }
        }
    ],

    provisionWaitTask: {
        name: 'cnapi.wait_for_fabric_nat_provisions',
        timeout: 600,
        retry: 1,
        body: waitForFabricNatProvisions,
        modules: { sdcClients: 'sdc-clients', async: 'async' }
    },

    getFabricNatNics: {
        name: 'napi.get_fabric_nat_nics',
        timeout: 60,
        retry: 1,
        body: getFabricNatNics,
        modules: { sdcClients: 'sdc-clients', async: 'async' }
    },

    destroyChain: [
        {
            name: 'cnapi.acquire_fabric_nat_tickets',
            timeout: 60,
            retry: 1,
            body: acquireFabricTickets,
            modules: { sdcClients: 'sdc-clients', async: 'async' }
        },
        {
            name: 'napi.destroy_fabric_nats',
            timeout: 300,
            retry: 1,
            body: destroyFabricNats,
            modules: { sdcClients: 'sdc-clients', async: 'async' }
        },
        {
            name: 'cnapi.release_fabric_nat_tickets',
            timeout: 60,
            retry: 1,
            body: releaseFabricNatTickets,
            modules: { sdcClients: 'sdc-clients', async: 'async' }
        }
    ],

    releaseFabricNatTickets: {
        name: 'cnapi.release_fabric_nat_tickets',
        timeout: 60,
        retry: 1,
        body: releaseFabricNatTickets,
        modules: { sdcClients: 'sdc-clients', async: 'async' }
    }
};
