/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017, Joyent, Inc.
 */

/*
 * This job adds a new NIC to a VM. It needs to checks that the nic tags
 * required by the NIC are present on the CN, creates a NIC in NAPI
 * (but only if 'networks' are provided in the job params), then invoke CNAPI
 * to create the NIC on the CN itself and attach it to the VM.
 *
 * Although this job only creates a NIC in NAPI if 'networks' is provided --
 * if 'mac' is provided, the NIC was already pre-created in NAPI -- this job
 * must always delete the NIC from NAPI on job failure.
 */

var async;  // stub to keep jsl happy
var common = require('./job-common');
var VERSION = '7.1.0';


/*
 * Sets up a CNAPI VM action request. Take a look at common.zoneAction. Here you
 * can set parameters such as:
 * - request endpoint (usually the VM endpoint)
 * - jobid (so CNAPI can post status updates back to the job info object)
 * - requestMethod
 * - expects (if you want to check a specific running status of the machine)
 */
function setupRequest(job, cb) {
    job.endpoint = '/servers/' +
                   job.params['server_uuid'] + '/vms/' +
                   job.params['vm_uuid'] + '/update';
    job.params.jobid = job.uuid;
    job.requestMethod = 'post';
    job.action = 'add_nics';
    job.server_uuid = job.params['server_uuid'];

    return cb(null, 'Request has been setup!');
}


/*
 * Get server object so we can check if it has the corresponding NIC tags
 */
function getServerNicTags(job, cb) {
    var cnapi = new sdcClients.CNAPI({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    // Goes inside the "NIC Names" array and extracts the NIC Tags for each NIC
    function mapNics(object) {
        var nics = [];

        for (var key in object) {
            var subNics = object[key]['NIC Names'];
            nics = nics.concat(subNics);
        }

        return nics;
    }

    // Goes inside the "Overlay Nic Tags" array and extracts the NIC Tags for
    // each vnic
    function mapVnics(object) {
        var nics = [];
        if (!object) {
            object = {};
        }

        for (var key in object) {
            var subNics = object[key]['Overlay Nic Tags'];
            nics = nics.concat(subNics);
        }

        return nics;
    }

    cnapi.getServer(job.params.server_uuid, function (err, server) {
        if (err) {
            return cb(err);
        }

        job.serverNicTags =
            mapNics(server.sysinfo['Network Interfaces']).concat(
            mapVnics(server.sysinfo['Virtual Network Interfaces']));

        return cb();
    });
}


/*
 * Checks that the server has the NIC tags for every network or NIC that was
 * passed.
 */
function checkServerNicTags(job, cb) {
    var napi = new sdcClients.NAPI({
        url: napiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    function done(err) {
        if (err) {
            cb(err);
        } else {
            cb(null, 'Server has all the required NIC tags');
        }
    }

    var macs = job.params.macs;

    // If 'macs' was passed, we're dealing with pre-created NICs, so we need
    // to pull the NICs from NAPI first.
    if (macs) {
        async.mapSeries(macs, function (mac, next) {
            napi.getNic(mac, function (err, nic) {
                if (err) {
                    return next(err);
                }

                var msg;
                var nicTag = nic.nic_tag;

                if (!nicTag) {
                    msg = 'NIC does not have a tag';
                    return next(new Error(msg));
                }

                // this hack is to split the nic tag off from the vnet_id,
                // which fabric nics have embedded in their nic_tag attribute
                var overlay = nicTag.match(/^(.+)\/\d+$/);
                nicTag = overlay ? overlay[1] : nicTag;

                if (job.serverNicTags.indexOf(nicTag) === -1) {
                    msg = 'Server does not have NIC tag: ' + nicTag;
                    return next(new Error(msg));
                }

                return next();
            });
        }, done);

    // Otherwise we're dealing with networks. nicTags for these networks were
    // loaded by the common.validateNetworks() task below.
    } else {
        for (var i = 0; i !== job.nicTags.length; i++) {
            var tag = job.nicTags[i];

            if (job.serverNicTags.indexOf(tag) === -1) {
                return done(new Error('Server does not have NIC tag: ' + tag));
            }
        }

        return done();
    }
}


var workflow = module.exports = {
    name: 'add-nics-' + VERSION,
    version: VERSION,
    chain: [ {
        name: 'common.validate_params',
        timeout: 10,
        retry: 1,
        body: common.validateForZoneAction,
        modules: {}
    }, {
        name: 'common.setup_request',
        timeout: 10,
        retry: 1,
        body: setupRequest,
        modules: {}
    }, {
        name: 'napi.validate_networks',
        timeout: 10,
        retry: 1,
        body: common.validateNetworks,
        modules: { sdcClients: 'sdc-clients', async: 'async' }
    }, {
        name: 'cnapi.get_server_nic_tags',
        timeout: 10,
        retry: 1,
        body: getServerNicTags,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'napi.check_server_nic_tags',
        timeout: 10,
        retry: 1,
        body: checkServerNicTags,
        modules: { sdcClients: 'sdc-clients', async: 'async' }
    }, {
        name: 'napi.provision_nics',
        timeout: 20,
        retry: 1,
        body: common.addNics,
        modules: { sdcClients: 'sdc-clients', async: 'async' }
    }, {
        name: 'common.update_network_params',
        timeout: 10,
        retry: 1,
        body: common.updateNetworkParams,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'cnapi.acquire_vm_ticket',
        timeout: 10,
        retry: 1,
        body: common.acquireVMTicket,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'cnapi.wait_on_vm_ticket',
        timeout: 120,
        retry: 1,
        body: common.waitOnVMTicket,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'cnapi.update_vm',
        timeout: 10,
        retry: 1,
        body: common.zoneAction,
        modules: { restify: 'restify' }
    }, {
        name: 'cnapi.wait_task',
        timeout: 120,
        retry: 1,
        body: common.waitTask,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'vmapi.check_updated',
        timeout: 90,
        retry: 1,
        body: common.checkUpdated,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'vmapi.put_vm',
        timeout: 60,
        retry: 1,
        body: common.putVm,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'fwapi.update',
        timeout: 10,
        retry: 1,
        body: common.updateFwapi,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'cnapi.release_vm_ticket',
        timeout: 60,
        retry: 1,
        body: common.releaseVMTicket,
        modules: { sdcClients: 'sdc-clients' }
    }],
    timeout: 300,
    onerror: [ {
        name: 'napi.cleanup_nics',
        timeout: 10,
        retry: 1,
        body: common.cleanupNics,
        modules: { sdcClients: 'sdc-clients', async: 'async' }
    }, {
        name: 'on_error.release_vm_ticket',
        modules: { sdcClients: 'sdc-clients' },
        body: function (job, cb) {
            var cnapi = new sdcClients.CNAPI({
                url: cnapiUrl,
                headers: { 'x-request-id': job.params['x-request-id'] }
            });
            cnapi.waitlistTicketRelease(job.ticket.uuid, function (err) {
                cb('Error executing job');
                return;
            });
        }
    }],
    oncancel: [ {
        name: 'on_cancel.release_vm_ticket',
        modules: { sdcClients: 'sdc-clients' },
        body: function (job, cb) {
            var cnapi = new sdcClients.CNAPI({
                url: cnapiUrl,
                headers: { 'x-request-id': job.params['x-request-id'] }
            });
            cnapi.waitlistTicketRelease(job.ticket.uuid, function (err) {
                cb();
                return;
            });
        }
    } ]
};
