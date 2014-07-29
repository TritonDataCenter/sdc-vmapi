/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var async = require('async');
var restify = require('restify');
var common = require('./job-common');
var childProcess = require('child_process');

var VERSION = '7.1.4';


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
 * If a server_uuid was already provided (thus skipping DAPI's checks above),
 * we'd still like to at least ensure that the manually-selected server has the
 * sufficient matching nic-tags.
 *
 * This function only applies if params['server_uuid'] was provided by the
 * entity (e.g. person) invoking the provision.
 */
function checkManualServerNics(job, cb) {
    var serverUuid = job.params['server_uuid'];

    if (!serverUuid) {
        return cb();
    }

    var headers = { 'x-request-id': job.params['x-request-id'] };
    var cnapi = new sdcClients.CNAPI({ url: cnapiUrl, headers: headers });

    return cnapi.getServer(serverUuid, function (err, server) {
        if (err) {
            return cb(err);
        }

        var nicTags = job.nicTags;
        var interfaces = server.sysinfo['Network Interfaces'];
        var found = 0;

        Object.keys(interfaces).forEach(function (iname) {
            var serverTags = interfaces[iname]['NIC Names'];

            for (var i = 0; i < nicTags.length; i++) {
                if (serverTags.indexOf(nicTags[i]) !== -1) {
                    found++;
                }
            }
        });

        if (found == nicTags.length) {
            return cb(null, 'Manual server meets NIC Tag requirements');
        } else {
            return cb('Manual server does not meet NIC Tag requirements');
        }
    });
}



/*
 * Selects a server for the VM. This function will send VM, image, package and
 * nic-tag requirements to DAPI, and let it figure out which server best fits
 * the requirements.
 *
 * Note that if you pass params['server_uuid'], this function will terminate
 * early, because you have already specified the server you want to provision.
 */
function getAllocation(job, cb) {
    var nicTags = job.nicTags;
    var pkg = job.params.package;
    var img = job.params.image;

    if (!nicTags) {
        return cb('NIC tags are required');
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

    var payload = {
        vm: job.params,
        image: img,
        package: pkg,
        nic_tags: nicTags
    };

    job.log.info({ dapiPayload: payload }, 'Payload sent to DAPI');

    return cnapi.post('/allocate', payload, function (err, req, res, body) {
        if (err) {
            return cb(err);
        }

        job.params['server_uuid'] = body.server.uuid;
        job.server_uuid = body.server.uuid;
        return cb(null, 'VM allocated to Server ' + body.server.uuid);
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
        'firewall_enabled', 'fs_allowed', 'hostname', 'indestructible_zoneroot',
        'indestructible_delegated', 'internal_metadata', 'kernel_version',
        'limit_priv', 'maintain_resolvers', 'max_locked_memory', 'max_lwps',
        'max_physical_memory', 'max_swap', 'mdata_exec_timeout', 'nics',
        'owner_uuid', 'package_name', 'package_version', 'quota', 'ram',
        'resolvers', 'vcpus', 'zfs_data_compression', 'zfs_io_priority',
        'tags', 'tmpfs'
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

    if (wantResolvers) {
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

    job.params.payload = payload;
    cb(null, 'Payload prepared successfully');
}



/*
 * Checks if the VM image is present on the compute node and installs it if it
 * is not.
 */
function ensureImage(job, cb) {
    var imageUuid;

    var commonHeaders = { 'x-request-id': job.params['x-request-id'] };
    var cnapi = new sdcClients.CNAPI({ url: cnapiUrl, headers: commonHeaders });

    if (job.params['brand'] === 'kvm') {
        imageUuid = job.params.payload.disks[0].image_uuid;
    } else {
        imageUuid = job.params.image_uuid;
    }

    cnapi.ensureImage(job.params['server_uuid'], imageUuid,
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
 * common.zoneAction. Here, we also make sure if we are trying to provision an
 * autoboot machine, in which case the job.expects attribute value should be
 * stopped (and then common.checkState waits for the machine to be stopped)
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
    // If this is false it means that cnapi.pollTask succeeded, so the VM exists
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

function setJobAction (job, cb) {
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
    }, {
        name: 'cnapi.check_manual_server_nics',
        timeout: 10,
        retry: 1,
        body: checkManualServerNics,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'dapi.get_allocation',
        timeout: 10,
        retry: 1,
        body: getAllocation,
        modules: { restify: 'restify' }
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
        name: 'napi.provision_nics',
        timeout: 20,
        retry: 1,
        body: common.provisionNics,
        modules: { sdcClients: 'sdc-clients', async: 'async' }
    }, {
        name: 'prepare_payload',
        timeout: 10,
        retry: 1,
        body: preparePayload,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'cnapi.ensure_image',
        timeout: 300,
        retry: 1,
        body: ensureImage,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'cnapi.poll_task_ensure_image',
        timeout: 3600,
        retry: 1,
        body: common.pollTask,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'cnapi.provision_vm',
        timeout: 10,
        retry: 1,
        body: provision,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'cnapi.poll_task',
        timeout: 3600,
        retry: 1,
        body: common.pollTask,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'vmapi.check_state',
        timeout: 120,
        retry: 1,
        body: common.checkState,
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
    } ],
    timeout: 3810,
    onerror: [ {
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
        name: 'cnapi.cleanup_ticket',
        modules: { sdcClients: 'sdc-clients' },
        body: function (job, cb) {
            var cnapi = new sdcClients.CNAPI({
                url: cnapiUrl,
                headers: { 'x-request-id': job.params['x-request-id'] }
            });
            cnapi.waitlistTicketRelease(job.ticket.uuid, cb);
        }
    },
    {
        name: 'On error',
        modules: {},
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }],
    oncancel: [ {
        name: 'On cancel',
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
