/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017, Joyent, Inc.
 */

/*
 * A brief overview of this source file: what is its purpose.
 */

var async = require('async');
var childProcess = require('child_process');
var restify = require('restify');

var common = require('./job-common');
var fabricCommon = require('./fabric-common');
var nfsVolumes = require('./nfs-volumes');

var wfapiUrl;

var VERSION = '7.5.1';


/*
 * Validates that the needed provision parameters are present
 */
function validateParams(job, cb) {
    if (napiUrl === undefined) {
        return cb('No NAPI parameters provided');
    }

    if (ufdsUrl === undefined || ufdsDn === undefined ||
        ufdsPassword === undefined) {
        return cb('No UFDS parameters provided');
    }

    if (cnapiUrl === undefined) {
        return cb('No CNAPI URL provided');
    }

    if (fwapiUrl === undefined) {
        return cb('No FWAPI URL provided');
    }

    if (imgapiUrl === undefined) {
        return cb('No IMGAPI URL provided');
    }

    if (sapiUrl === undefined) {
        return cb('No SAPI URL provided');
    }

    if (job.params['owner_uuid'] === undefined) {
        return cb('\'owner_uuid\' is required');
    }

    if (job.params.brand === undefined) {
        return cb('VM \'brand\' is required');
    }

    return cb(null, 'All parameters OK!');
}



/*
 * Generates passwords when the image requires it
 */
function generatePasswords(job, cb) {
    var log = job.log;
    var execFile = childProcess.execFile;
    var PWD_LENGTH = 12;
    var APG_COMMAND = '/opt/local/bin/apg';
    var APG_ARGS = [
        '-m', PWD_LENGTH,
        '-M', 'SCNL',
        '-n', 1,
        '-E', '"\'@$%&*/.:[]\\'
    ];

    if (job.params.image['generate_passwords'] === false) {
        return cb(null, 'No need to generate passwords for image');
    }

    if (job.params.image.users === undefined ||
        !Array.isArray(job.params.image.users)) {
        return cb(null, 'Image has generate_passwords=true but no users found');
    }

    if (job.params['internal_metadata'] === undefined) {
        job.params['internal_metadata'] = {};
    }

    var users = job.params.image.users;
    var name;
    var password;

    async.mapSeries(users, function (user, next) {
        name = user.name + '_pw';
        if (job.params['internal_metadata'][name]  === undefined) {
            execFile(APG_COMMAND, APG_ARGS, function (err, stdout, stderr) {
                if (err) {
                    log.info({ err: err }, 'Error generating random password');
                    return next(err);
                }

                password = stdout.toString().replace(/\n|\r/g, '');
                job.params['internal_metadata'][name] = password;
                return next();
            });
        } else {
            return next();
        }
    }, function (err) {
        if (err) {
            cb(err, 'Could not generate passwords');
        } else {
            cb(null, 'Passwords generated for Image');
        }
    });
}


/*
 * Selects a server for the VM. This function will send VM, image, package and
 * NIC tag requirements to DAPI, and let it figure out which server best fits
 * the requirements.
 *
 * Note that if you pass params['server_uuid'], this function will terminate
 * early, because you have already specified the server you want to provision.
 */
function getAllocation(job, cb) {
    var nicTagReqs = job.nicTagReqs;
    var pkg = job.params.package;
    var img = job.params.image;

    if (!nicTagReqs) {
        cb('NIC tag requirements must be present');
        return;
    }

    if (!img) {
        return cb('Image is required');
    }

    if (job.params['server_uuid']) {
        cb(null, 'Server UUID present, no need to get allocation from DAPI');
        return;
    }

    // There is no sdc-client for CNAPI's DAPI yet
    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    /*
     * In case we're talking to an older DAPI from before heterogeneous pools
     * were supported, we select the first tag from each list of alternatives.
     */
    var nicTags = nicTagReqs.map(function extractFirstTag(arr) {
        return arr[0];
    });

    var payload = {
        vm: job.params,
        image: img,
        package: pkg,
        nic_tags: nicTags,
        nic_tag_requirements: nicTagReqs
    };

    job.log.info({ dapiPayload: payload }, 'Payload sent to DAPI');

    cnapi.post('/allocate', payload, function finish(err, req, res, body) {
        if (err) {
            cb(err);
            return;
        }

        var server_uuid = body.server.uuid;
        job.params.server_uuid = server_uuid;
        job.params.imgapiPeers = body.imgapiPeers;
        job.server_uuid = server_uuid;
        job.server_info = {
            sysinfo: {
                'Network Interfaces':
                    body.server.sysinfo['Network Interfaces'],
                'Virtual Network Interfaces':
                    body.server.sysinfo['Virtual Network Interfaces']
            }
        };

        cb(null, 'VM allocated to Server ' + server_uuid);
    });
}



/**
 * Set up the payload that will be sent to CNAPI and will be used to provision
 * the virtual machine.
 */
function preparePayload(job, cb) {
    job.params.jobid = job.uuid;

    var params = job.params;
    var i, j, nic;
    var parsedNfsMetadata;
    var payload = { uuid: params['vm_uuid'], image: job.params.image };
    var wantResolvers = true;

    if (payload.image.hasOwnProperty('tags') &&
        payload.image.tags.hasOwnProperty('kernel_version') &&
        !params.hasOwnProperty('kernel_version')) {

        params['kernel_version'] = payload.image.tags.kernel_version;
    }

    if (payload.image.type === 'lx-dataset') {
        params['brand'] = 'lx';
    }

    var keys = [ 'alias', 'autoboot', 'billing_id', 'brand', 'cpu_cap',
        'cpu_shares', 'customer_metadata', 'delegate_dataset', 'dns_domain',
        'docker', 'firewall_enabled', 'firewall_rules', 'fs_allowed',
        'hostname', 'indestructible_zoneroot', 'indestructible_delegated',
        'init_name', 'internal_metadata', 'kernel_version', 'limit_priv',
        'maintain_resolvers', 'max_locked_memory', 'max_lwps', 'max_msg_ids',
        'max_physical_memory', 'max_shm_memory', 'max_sem_ids', 'max_shm_ids',
        'max_swap', 'mdata_exec_timeout', 'nics',
        'owner_uuid', 'quota', 'ram',
        'resolvers', 'vcpus', 'zfs_data_compression', 'zfs_io_priority',
        'zlog_max_size', 'tags', 'tmpfs'
    ];

    for (i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (params[key] !== undefined) {
            payload[key] = params[key];
        }
    }

    // Per OS-2520 we always want to be setting archive_on_delete in SDC
    payload['archive_on_delete'] = true;

    // If internal_metadata.set_resolvers === false, we always want
    // to leave the resolvers as empty
    if (params.internal_metadata !== undefined &&
        typeof (params.internal_metadata) === 'object' &&
        params.internal_metadata.set_resolvers === false) {
        wantResolvers = false;
    }

    // Add resolvers and routes in the order of the networks
    var resolver;
    var resolvers = [];
    var routes = {};
    for (i = 0; i <  params.nics.length; i++) {
        nic = params.nics[i];

        if (nic['resolvers'] !== undefined &&
            Array.isArray(nic['resolvers'])) {
            for (j = 0; j < nic['resolvers'].length; j++) {
                resolver = nic['resolvers'][j];
                if (resolvers.indexOf(resolver) === -1) {
                    resolvers.push(resolver);
                }
            }
        }

        if (nic['routes'] !== undefined &&
            typeof (nic['routes']) === 'object') {
            for (var r in nic['routes']) {
                if (!routes.hasOwnProperty(r)) {
                    routes[r] = nic['routes'][r];
                }
            }
        }
    }

    if (wantResolvers && !payload.resolvers) {
        payload['resolvers'] = resolvers;
    }

    if (Object.keys(routes).length !== 0) {
        payload['routes'] = routes;
    }

    if (params['brand'] === 'kvm') {
        payload.disks = params.disks;

        ['disk_driver', 'nic_driver', 'cpu_type'].forEach(function (field) {
            if (params[field]) {
                payload[field] = params[field];
            } else {
                payload[field] = job.params.image[field];
            }
        });
    } else {
        payload['image_uuid'] = params['image_uuid'];

        if (params['filesystems'] !== undefined) {
            payload['filesystems'] = params['filesystems'];
        }
    }

    if (params.imgapiPeers !== undefined) {
        payload.imgapiPeers = params.imgapiPeers;
    }

    if (job.nfsVolumesInternalMetadata !== undefined) {
        job.log.info({
            docker: Boolean(job.params.docker),
            nfsVolumesInternalMetadata: job.nfsVolumesInternalMetadata
        }, 'Setting nfsvolumes internal metadata');

        if (!payload.hasOwnProperty('internal_metadata')) {
            payload.internal_metadata = {};
        }

        if (job.params.docker === true) {
            // We create a separate copy of the metadata for docker:nfsvolumes,
            // because that needs a 'readonly' parameter instead of 'mode' for
            // historical reasons.
            parsedNfsMetadata = JSON.parse(job.nfsVolumesInternalMetadata);

            if (!Array.isArray(parsedNfsMetadata)) {
                cb(new Error('parsed nfsvolumes is not an array'));
                return;
            }

            // replace .mode = <string> with .readonly = true|false
            parsedNfsMetadata.forEach(function _eachVol(volObj) {
                volObj.readonly = (volObj.mode === 'ro');
                delete volObj.mode;
            });

            payload.internal_metadata['docker:nfsvolumes']
                = JSON.stringify(parsedNfsMetadata);
        }

        payload.internal_metadata['sdc:volumes'] =
            job.nfsVolumesInternalMetadata;
    }

    job.params.payload = payload;
    cb(null, 'Payload prepared successfully');
}



/*
 * Checks if the VM image is present on the compute node and installs it if it
 * is not.
 */
function ensureImage(job, cb) {
    var commonHeaders = { 'x-request-id': job.params['x-request-id'] };
    var cnapi = new sdcClients.CNAPI({ url: cnapiUrl, headers: commonHeaders });

    var ensurePayload = {};

    if (job.params['brand'] === 'kvm') {
        ensurePayload.image_uuid = job.params.payload.disks[0].image_uuid;
    } else {
        ensurePayload.image_uuid = job.params.image_uuid;
    }

    if (job.params.imgapiPeers !== undefined) {
        ensurePayload.imgapiPeers = job.params.imgapiPeers;
    }

    cnapi.ensureImage(job.params['server_uuid'], ensurePayload,
                      function (error, task) {
        if (error) {
            return cb(error);
        }

        job.taskId = task.id;
        return cb(null, 'Ensure image task queued!');
    });
}



/*
 * Calls the provision endpoint on CNAPI. This function is very similar to
 * common.zoneAction.
 */
function provision(job, cb) {
    delete job.params.skip_zone_action;

    var cnapi = new sdcClients.CNAPI({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });
    job.params.jobid = job.uuid;

    // autoboot=false means we want the machine to not to boot after provision
    if (job.params.autoboot === false || job.params.autoboot === 'false') {
        job.expects = 'stopped';
    } else {
        job.expects = 'running';
    }

    var server = job.params['server_uuid'];

    return cnapi.createVm(server, job.params.payload, function (err, task) {
        if (err) {
            return cb(err);
        } else {
            job.taskId = task.id;
            // As soon was we reach this point, we don't want to clean up NICs
            // when a provision fails
            job.markAsFailedOnError = false;
            return cb(null, 'Provision task: ' + task.id + ' queued!');
        }
    });
}



/*
 * Sets the post back execution state as failed
 */
function setPostBackFailed(job, cb) {
    // If this is false it means that cnapi.waitTask succeeded, so the VM exists
    // physically wether its provision failed or not
    if (job.markAsFailedOnError === false) {
        return cb(null, 'markAsFailedOnError was set to false, ' +
            'won\'t set postBackState for VM');
    }

    job.postBackState = 'failed';
    return cb(null, 'Set post back state as failed');
}


/**
 * Records the type of workflow for debugging/informational purposes. For
 * example when creating a waitlist ticket.
 */

function setJobAction(job, cb) {
    job.action = 'provision';
    return cb(null, 'Action set');
}


var workflow = module.exports = {
    name: 'provision-' + VERSION,
    version: VERSION,
    chain: [ {
        name: 'common.validate_params',
        timeout: 10,
        retry: 1,
        body: validateParams
    },
    {
        name: 'workflow.set_job_action',
        timeout: 10,
        retry: 1,
        body: setJobAction,
        modules: {}
    },
    {
        name: 'imgapi.generate_passwords',
        timeout: 10,
        retry: 1,
        body: generatePasswords,
        modules: { childProcess: 'child_process', async: 'async' }
    }, {
        name: 'napi.validate_networks',
        timeout: 10,
        retry: 1,
        body: common.validateNetworks,
        modules: { sdcClients: 'sdc-clients', async: 'async' }
    },

    /**
     * Here we serialize the compute node designation api (DAPI) portion of the
     * workflow via the CNAPI waitlist to ensure that only one allocation
     * happens at a time. In addition to serialiing all the designations via
     * the waitlist, we will create waitlist tickets for the provision itself.
     * DAPI will use the provision tickets to know whether there are in-flight
     * provisions and prevent multiple concurrent provisions from inadvertently
     * all ending up on the same compute node.
     */

    {
        name: 'dapi.get_allocation_ticket',
        timeout: 30,
        retry: 1,
        body: common.acquireAllocationTicket,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'dapi.wait_allocation_ticket',
        timeout: 120,
        retry: 1,
        body: common.waitOnAllocationTicket,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'dapi.get_allocation',
        timeout: 30,
        retry: 1,
        body: getAllocation,
        modules: { restify: 'restify' }
    }, {
        name: 'cnapi.acquire_vm_ticket',
        timeout: 30,
        retry: 1,
        body: common.acquireVMTicket,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'dapi.release_allocation_ticket',
        timeout: 30,
        retry: 1,
        body: common.releaseAllocationTicket,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'cnapi.wait_on_vm_ticket',
        timeout: 120,
        retry: 1,
        body: common.waitOnVMTicket,
        modules: { sdcClients: 'sdc-clients' }
    },

    /**
     * End of DAPI serialization section.
     */

    {
        name: 'cnapi.get_server_nic_tags',
        timeout: 10,
        retry: 1,
        body: common.getServerNicTags,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'cnapi.check_manual_server_nics',
        timeout: 10,
        retry: 1,
        body: common.checkServerNicTags,
        modules: { sdcClients: 'sdc-clients' }
    },
    {
        name: 'napi.provision_nics',
        timeout: 20,
        retry: 1,
        body: common.provisionNics,
        modules: { sdcClients: 'sdc-clients', async: 'async' }
    }

    /**
     * Fabric NAT provisioning
     */
    ].concat(
        fabricCommon.provisionChain).concat([ {
        name: 'cnapi.ensure_image',
        timeout: 300,
        retry: 1,
        body: ensureImage,
        modules: { sdcClients: 'sdc-clients' }
    },
    {
        name: 'cnapi.wait_task_ensure_image',
        timeout: 3600,
        retry: 1,
        body: common.waitTask,
        modules: { sdcClients: 'sdc-clients' }
    },
    /*
     * If we've provisioned fabric NAT zones for this VM, wait until
     * they've finished before sending off the provision.
     */
    fabricCommon.provisionWaitTask
    ]).concat(
        /*
         * Now that all dependent tasks that can fail but provisioning required
         * volumes and the VM itself have been done, it's time to provision
         * required volumes. Doing it beforehand would potentially make the
         * costly process of provisioning required volumes start before we even
         * know if anything else that could fail has succeeded.
         */
        nfsVolumes.provisionChain).concat([
    {
        name: 'prepare_payload',
        timeout: 10,
        retry: 1,
        body: preparePayload,
        modules: { sdcClients: 'sdc-clients' }
    },
    {
        name: 'cnapi.provision_vm',
        timeout: 10,
        retry: 1,
        body: provision,
        modules: { sdcClients: 'sdc-clients' }
    },
    {
        name: 'cnapi.wait_task',
        timeout: 3600,
        retry: 1,
        body: common.waitTask,
        modules: { sdcClients: 'sdc-clients' }
    },
    /*
     * It is possible for this operation to either fail or never happen (due to
     * the workflow job failing before getting to this task, etc.). It is not a
     * critical problem though. Indeed, in this case, a volume reservation would
     * have taken place beforehand, and a background async process running in
     * the VOLAPI zone would monitor these reservations to add the corresponding
     * references when the VM is provisioned.
     * We're still performing this operation here so that:
     *
     * 1. The volume references are consistent with the provisioning request
     *    when the provisioning workflow completes, not just at some point in
     *    the future.
     *
     * 2. in case VOLAPI's background process is not functionning, the reference
     *    is added (and the reservation cleaned up) before that process comes
     *    back up.
     */
    {
        name: 'volapi.add_volumes_references',
        timeout: 120,
        retry: 1,
        body: nfsVolumes.addVolumesReferences,
        modules: { sdcClients: 'sdc-clients', vasync: 'vasync' }
    },
    {
        name: 'vmapi.put_vm',
        timeout: 120,
        retry: 1,
        body: common.putVm,
        modules: { sdcClients: 'sdc-clients' }
    },
    {
        name: 'fwapi.update',
        timeout: 10,
        retry: 1,
        body: common.updateFwapi,
        modules: { sdcClients: 'sdc-clients' }
    },
    {
        name: 'cnapi.release_vm_ticket',
        timeout: 60,
        retry: 1,
        body: common.releaseVMTicket,
        modules: { sdcClients: 'sdc-clients' }
    },

    // If this was a fabric nat provision, clean up the ticket
    fabricCommon.releaseTicketTask

    ]),
    timeout: 3810,
    onerror: [
    /*
     * We don't cleanup volume references or reservations in case the provision
     * failed. Instead, we rely on the 'common.post_back' task to update the VM
     * in VMAPI to a state === 'failed', which would generate a changefeed event
     * that VOLAPI would process to cleanup those references and reservations.
     * That process itself could fail too, but we consider that adding
     * additional task to the onerror tasks chain would be more disruptive, and
     * would also fail sometimes. In other words, the net effect might not be
     * positive, and we can revisit that decision later.
     */
    {
        name: 'napi.cleanup_nics',
        timeout: 10,
        retry: 1,
        body: common.cleanupNics,
        modules: { sdcClients: 'sdc-clients', async: 'async' }
    }, {
        name: 'set_post_back_failed',
        body: setPostBackFailed,
        modules: {}
    }, {
        name: 'common.post_back',
        body: common.postBack,
        modules: { async: 'async', restify: 'restify', urlModule: 'url' }
    },
    {
        name: 'cnapi.cleanup_allocation_ticket',
        modules: { sdcClients: 'sdc-clients' },
        body: common.releaseAllocationTicket
    },
    {
        name: 'cnapi.cleanup_vm_ticket',
        modules: { sdcClients: 'sdc-clients' },
        body: common.releaseVMTicket
    },
    {
        name: 'vmapi.refresh_vm_on_error',
        modules: { restify: 'restify' },
        body: common.refreshVm
    },

    // If this was a fabric nat provision, clean up the ticket
    fabricCommon.releaseTicketTask,
    {
        name: 'On error',
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }],
    oncancel: [ {
        name: 'vmapi.refresh_vm',
        modules: { restify: 'restify' },
        body: common.refreshVm
    }, {
        name: 'cnapi.cleanup_vm_ticket',
        modules: { sdcClients: 'sdc-clients' },
        body: common.releaseVMTicket
    },
    {
        name: 'cnapi.cleanup_allocation_ticket',
        modules: { sdcClients: 'sdc-clients' },
        body: common.releaseAllocationTicket
    },

    // If this was a fabric nat provision, clean up the ticket
    fabricCommon.releaseTicketTask
    ]
};
