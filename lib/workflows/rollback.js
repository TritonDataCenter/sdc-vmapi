/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * A brief overview of this source file: what is its purpose.
 */

var common = require('./job-common');
var VERSION = '7.0.5';


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
    job.endpoint = '/servers/' + job.params['server_uuid'] + '/vms/' +
                    job.params['vm_uuid'] + '/snapshots/' +
                    job.params['snapshot_name'] + '/rollback';
    job.params.jobid = job.uuid;
    job.requestMethod = 'put';
    job.expects = 'running';
    job.action = 'rollback';
    job.server_uuid = job.params['server_uuid'];

    // If we skipped stop because the VM was already stopped we want to
    // clear this flag so the rest of the operations can be called
    delete job.params['skip_zone_action'];

    return cb(null, 'Rollback request has been setup');
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
    job.action = 'stop';

    var message;

    // Only shutdown machine if it's running
    if (job.params['vm_state'] == 'running') {
        message = 'Stop request has been setup';
    } else {
        job.params['skip_zone_action'] = true;
        message = 'No need to stop VM';
    }

    return cb(null, message);
}



/*
 * Validates that the snapshot name to rollback is present
 */
function validateSnapshotName(job, cb) {
    if (!job.params['snapshot_name']) {
        cb('No snapshot name provided');
    }

    cb(null, 'Snapshot name ' + job.params['snapshot_name'] + ' is valid');
}



var workflow = module.exports = {
    name: 'rollback-' + VERSION,
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
        name: 'common.setup_stop_request',
        timeout: 10,
        retry: 1,
        body: setupStopRequest,
        modules: {}
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
        name: 'cnapi.stop_vm',
        timeout: 10,
        retry: 1,
        body: common.zoneAction,
        modules: { restify: 'restify' }
    }, {
        name: 'cnapi.poll_stop_task',
        timeout: 120,
        retry: 1,
        body: common.waitTask,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'cnapi.release_vm_ticket',
        timeout: 60,
        retry: 1,
        body: common.releaseVMTicket,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'common.setup_rollback_request',
        timeout: 10,
        retry: 1,
        body: setupRollbackRequest,
        modules: {}
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
        name: 'cnapi.rollback_vm',
        timeout: 20,
        retry: 1,
        body: common.zoneAction,
        modules: { restify: 'restify' }
    }, {
        name: 'cnapi.poll_rollback_task',
        timeout: 120,
        retry: 1,
        body: common.waitTask,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'vmapi.put_vm',
        timeout: 60,
        retry: 1,
        body: common.putVm,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'cnapi.release_vm_ticket',
        timeout: 60,
        retry: 1,
        body: common.releaseVMTicket,
        modules: { sdcClients: 'sdc-clients' }
    }],
    timeout: 300,
    onerror: [ common.tasks.releaseVMTicketIgnoringErr ],
    oncancel: [ common.tasks.releaseVMTicketIgnoringErr ]
};
