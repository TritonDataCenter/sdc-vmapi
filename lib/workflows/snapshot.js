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
var VERSION = '7.0.4';


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
                    job.params['vm_uuid'] + '/snapshots';
    job.params.jobid = job.uuid;
    job.requestMethod = 'put';
    job.action = 'snapshot';
    job.server_uuid = job.params['server_uuid'];

    return cb(null, 'Request has been setup!');
}



/*
 * Validates that the snapshot name to be created is present
 */
function validateSnapshotName(job, cb) {
    if (!job.params['snapshot_name']) {
        cb('No snapshot name provided');
    }

    cb(null, 'Snapshot name ' + job.params['snapshot_name'] + ' is valid');
}



var workflow = module.exports = {
    name: 'snapshot-' + VERSION,
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
        name: 'cnapi.snapshot_vm',
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
        name: 'vmapi.put_vm',
        timeout: 120,
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
    timeout: 180,
    onerror: [ common.tasks.releaseVMTicketIgnoringErr ],
    oncancel: [ common.tasks.releaseVMTicketIgnoringErr ]
};
