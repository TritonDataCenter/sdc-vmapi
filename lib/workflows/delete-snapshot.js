/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var common = require('./job-common');
var VERSION = '7.0.0';


/*
 * Sets up a CNAPI VM action request. Take a look at common.zoneAction. Here you
 * can set parameters such as:
 * - request endpoint (usually the VM endpoint)
 * - jobid (so CNAPI can post status updates back to the job info object)
 * - requestMethod
 * - expects (if you want to check a specific running status of the machine)
 */
function setupRequest(job, cb) {
    job.endpoint = '/servers/' + job.params['server_uuid'] + '/vms/' +
                    job.params['vm_uuid'] + '/snapshots/' +
                    job.params['snapshot_name'];
    job.params.jobid = job.uuid;
    job.expects = 'running';
    job.requestMethod = 'del';

    return cb(null, 'Request has been setup!');
}



/*
 * Validates that the snapshot name to be created is present
 */
function validateSnapshotName(job, cb) {
    if (!job.params['snapshot_name']) {
        cb('No snapshot name provided');
    }

    cb(null, 'Snapshot name is valid');
}



var workflow = module.exports = {
    name: 'delete-snapshot-' + VERSION,
    version: VERSION,
    chain: [ {
        name: 'common.validate_params',
        timeout: 10,
        retry: 1,
        body: common.validateForZoneAction,
        modules: {}
    }, {
        name: 'common.validate_snapshot_name',
        timeout: 10,
        retry: 1,
        body: validateSnapshotName,
        modules: {}
    }, {
        name: 'common.setup_request',
        timeout: 10,
        retry: 1,
        body: setupRequest,
        modules: {}
    }, {
        name: 'cnapi.delete_snapshot',
        timeout: 10,
        retry: 1,
        body: common.zoneAction,
        modules: { restify: 'restify' }
    }, {
        name: 'cnapi.poll_task',
        timeout: 120,
        retry: 1,
        body: common.pollTask,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'vmapi.refresh_vm',
        timeout: 10,
        retry: 1,
        body: common.refreshVm,
        modules: { restify: 'restify' }
    }],
    timeout: 180,
    onerror: [ {
        name: 'On error',
        modules: {},
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }]
};
