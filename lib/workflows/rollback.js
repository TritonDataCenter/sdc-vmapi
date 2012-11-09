/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


// This is not really needed, but javascriptlint will complain otherwise:
var sdcClients = require('sdc-clients');
var common = require('./job-common');

var VERSION = '7.0.0';


/*
 * Sets up a CNAPI VM rollback request. Take a look at common.zoneAction. Here
 * you can set parameters such as:
 * - request endpoint (usually the VM endpoint)
 * - jobid (so CNAPI can post status updates back to the job info object)
 * - requestMethod
 * - expects (if you want to check a specific running status of the machine)
 *
 * In the case of rollbacks, you always want expects to be stopped (machine
 * needs to be off before rollback
 */
function setupRollbackRequest(job, cb) {
    var dataset = encodeURIComponent('zones/' + job.params['vm_uuid']);
    job.endpoint = '/servers/' +
                   job.params['server_uuid'] + '/datasets/' +
                   dataset + '/rollback';
    job.params.jobid = job.uuid;
    job.requestMethod = 'post';
    job.expects = 'stopped';

    return cb(null, 'Rollback request has been setup');
}



/*
 * Sets up a CNAPI VM start request. Take a look at common.zoneAction
 */
function setupStartRequest(job, cb) {
    job.endpoint = '/servers/' +
                   job.params['server_uuid'] + '/vms/' +
                   job.params['vm_uuid'] + '/start';
    job.params.jobid = job.uuid;
    job.requestMethod = 'post';
    job.expects = 'running';

    var message;

    // Only start machine if it was running before
    if (job.params['vm_state'] == 'running') {
        message = 'Start request has been setup';
    } else {
        job.params['skip_boot'] = true;
        message = 'No need to start VM';
    }

    return cb(null, message);
}



/*
 * Sets up a CNAPI VM stop request. Take a look at common.zoneAction
 */
function setupStopRequest(job, cb) {
    job.endpoint = '/servers/' +
                   job.params['server_uuid'] + '/vms/' +
                   job.params['vm_uuid'] + '/stop';
    job.params.jobid = job.uuid;
    job.requestMethod = 'post';
    job.expects = 'stopped';

    var message;

    // Only shutdown machine if it's running
    if (job.params['vm_state'] == 'running') {
        message = 'Stop request has been setup';
    } else {
        job.params['skip_boot'] = true;
        message = 'No need to stop VM';
    }

    return cb(null, message);
}



/*
 * Validates that the snapshot name to rollback is present
 */
function validateSnapshotName(job, cb) {
    if (!job.params['name']) {
        cb('No snapshot name provided');
    }

    cb(null, 'Snapshot name is valid');
}



var workflow = module.exports = {
    name: 'rollback-' + VERSION,
    version: VERSION,
    chain: [ {
        name: 'common.validate_params',
        timeout: 10,
        retry: 1,
        body: common.validateForZoneAction
    }, {
        name: 'common.validate_snapshot_name',
        timeout: 10,
        retry: 1,
        body: validateSnapshotName
    }, {
        name: 'common.setup_stop_request',
        timeout: 10,
        retry: 1,
        body: setupStopRequest
    }, {
        name: 'cnapi.stop_vm',
        timeout: 10,
        retry: 1,
        body: common.zoneAction
    }, {
        name: 'cnapi.poll_stop_task',
        timeout: 120,
        retry: 1,
        body: common.pollTask
    }, {
        name: 'common.setup_rollback_request',
        timeout: 10,
        retry: 1,
        body: setupRollbackRequest
    }, {
        name: 'cnapi.rollback_vm',
        timeout: 10,
        retry: 1,
        body: common.zoneAction
    }, {
        name: 'common.setup_start_request',
        timeout: 10,
        retry: 1,
        body: setupStartRequest
    }, {
        name: 'cnapi.start_vm',
        timeout: 10,
        retry: 1,
        body: common.zoneAction
    }, {
        name: 'cnapi.poll_start_task',
        timeout: 120,
        retry: 1,
        body: common.pollTask
    }, {
        name: 'vmapi.check_state',
        timeout: 60,
        retry: 1,
        body: common.checkState
    }],
    timeout: 400,
    onerror: [ {
        name: 'On error',
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }]
};
