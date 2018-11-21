/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * Used to migrate an instance, run via this workflow job.
 */

var assert = require('assert-plus');
var restify = require('restify');
var sdcClients = require('sdc-clients');

var common = require('./job-common');
var cleanup_source = require('./vm-migration/cleanup_source');
var cleanup_target = require('./vm-migration/cleanup_target');
var sync = require('./vm-migration/sync');

var VERSION = '1.0.0';

/*
 * Sets up a CNAPI VM action request. Take a look at common.zoneAction. Here you
 * can set parameters such as:
 * - request endpoint (usually the VM endpoint)
 * - jobid (so CNAPI can post status updates back to the job info object)
 * - requestMethod
 * - expects (if you want to check a specific running status of the machine)
 */
function setupRequest(job, cb) {
    var action = job.params.migrationTask.action;

    job.endpoint = '/servers/' +
                   job.params['server_uuid'] + '/vms/' +
                   job.params['vm_uuid'] + '/migrate';
    job.params.action = action;
    job.params.jobid = job.uuid;
    job.requestMethod = 'post';
    job.expects = 'running';
    job.action = 'migrate';
    job.server_uuid = job.params['server_uuid'];

    // Used to keep the task result around.
    job.store_task_result_in_attribute = 'source_cn_result';
    // Keep a running history for the record (debugging purposes).
    job.params.migrationTask.recordHistory = [job.params.migrationTask.record];

    return cb(null, 'OK - request has been setup ('
        + job.params['x-request-id'] + ')');
}


function migration_validate_task(job, cb) {
    assert.object(job.params.vm, 'job.params.vm');
    assert.string(job.params.vm_uuid, 'job.params.vm_uuid');

    if (!job.params.migrationTask ||
            typeof (job.params.migrationTask) !== 'object') {
        cb('Error - no migrationTask object defined');
        return;
    }

    var action = job.params.migrationTask.action;
    var record = job.params.migrationTask.record;

    var VALID_MIGRATION_ACTIONS = [
        'abort',
        'full',
        'pause',
        'start',
        'switch',
        'sync'
    ];

    if (VALID_MIGRATION_ACTIONS.indexOf(action) === -1) {
        cb('Error - invalid migration action: ' + action);
        return;
    }

    if (record) {
        var EXPECTED_FIELDS = [
            'created_timestamp',
            'id',
            'phase',
            'source_server_uuid',
            'state',
            'vm_uuid'
        ];
        var missingFields = EXPECTED_FIELDS.filter(function fieldFilter(field) {
            return (!record[field]);
        });
        if (missingFields.length > 0) {
            cb('Error - invalid migration record, missing: ' + missingFields);
            return;
        }
    }

    // Check that the migration record matches what is expected for the
    // migration action.
    if (record) {
        cb(null, 'OK - migration action "' + action + '" is valid, ' +
            'migration id: ' + record.id);
    } else {
        cb(null, 'OK - migration action "' + action + '" is valid, ' +
            'no record yet');
    }
}


/*
 * Create migration record if it doesn't exist (e.g. start), add progress entry.
 */
function migration_store_initial_record(job, cb) {
    var action = job.params.migrationTask.action;
    var message;
    var phase = action;
    var progressEntry;
    var progressHistory;
    var record;
    var startedTimestamp = (new Date()).toISOString();

    // Add record to the existing progress array.
    record = job.params.migrationTask.record;
    progressHistory = record.progress_history;
    if (!progressHistory) {
        progressHistory = [];
        record.progress_history = progressHistory;
    }
    delete record.error;

    // There are no running cn-agent processes to start with.
    record.source_process_details = {
        pid: -1,
        ppid: -1,
        host: '',
        port: -1
    };
    record.target_process_details = {
        pid: -1,
        ppid: -1,
        host: '',
        port: -1
    };

    // Create a progress entry.
    switch (action) {
        case 'start':
        case 'full':
            phase = 'start';
            message = 'reserving instance';
            break;
        case 'abort':
            message = 'aborting migration';
            break;
        case 'pause':
            message = 'pausing migration';
            break;
        case 'sync':
            message = 'syncing data';
            break;
        case 'switch':
            message = 'switching instances';
            break;
        default:
            message = 'unhandled migration action ' + action;
            break;
    }

    record.state = 'running';
    record.phase = phase;

    progressEntry = {
        message: message,
        phase: phase,
        state: 'running',
        started_timestamp: startedTimestamp,
        current_progress: 1,
        total_progress: 100,
        job_uuid: job.uuid
    };

    job.params.migrationTask.progressIdx = progressHistory.length;
    progressHistory.push(progressEntry);
    // Keep a running history for the record (debugging purposes).
    job.params.migrationTask.recordHistory.push(record);

    // Store the migration record.
    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: { 'x-request-id': job.params['x-request-id'] },
        url: vmapiUrl
    });
    var url = '/migrations/' + job.params.vm_uuid + '/store';

    rawVmapi.post(url, record,
            function _createMigrationRecordCb(err, req, res) {
        if (err) {
            cb(err);
            return;
        }

        // TODO: Store ETag?
        job.params.migrationTask.record = record;

        cb(null, 'OK - stored migration record, id ' + record.id);
    });
}


function migration_provision_vm(job, cb) {
    var action = job.params.migrationTask.action;

    if (action !== 'start' && action !== 'full') {
        cb(null, 'OK - not applicable for action ' + action);
        return;
    }

    // Mark that we don't want to perform the common zone action routine.
    job.params.skip_zone_action = true;

    // Shallow clone for an object.
    function clone(theObj) {
        if (null === theObj || 'object' != typeof (theObj)) {
            return theObj;
        }

        var copy = theObj.constructor();

        for (var attr in theObj) {
            if (theObj.hasOwnProperty(attr)) {
                copy[attr] = theObj[attr];
            }
        }
        return copy;
    }

    var vmapi = new sdcClients.VMAPI({
        log: job.log,
        headers: { 'x-request-id': job.params['x-request-id'] },
        url: vmapiUrl
    });

    var vmPayload = clone(job.params.vm);

    // Mark as a migrating instance.
    vmPayload.do_not_inventory = true;
    vmPayload.vm_migration_target = true;

    // XXX: Testing - tweak the uuid to allow on the same CN.
    vmPayload.uuid = vmPayload.uuid.slice(0, -6) + 'aaaaaa';
    vmPayload.alias = vmPayload.alias + '-aaaaaa';

    // Convert nics into network macs.
    if (vmPayload.nics) {
        vmPayload.networks = vmPayload.nics.map(function _nicToMac(nic) {
            var netObj = {
                mac: nic.mac,
                uuid: nic.network_uuid
            };
            if (nic.primary) {
                netObj.primary = nic.primary;
            }
            return netObj;
        });
        // vmPayload.networks = [];
        delete vmPayload.nics;
    }

    delete vmPayload.server_uuid;
    delete vmPayload.state;
    delete vmPayload.zone_state;
    delete vmPayload.pid;
    delete vmPayload.tmpfs;

    job.log.info({vm_payload: vmPayload}, 'creating vm migration target');

    vmapi.createVmAndWait(vmPayload, function _onCreateVmCb(vmErr, vmJob) {
        var record = job.params.migrationTask.record;
        var target_server_uuid;

        if (vmErr) {
            var progressEntry = record.progress_history[
                job.params.migrationTask.progressIdx];

            progressEntry.message = 'reserving instance failed - '
                + vmErr.message;
            cb(vmErr);
            return;
        }

        // Record where the server landed.
        if (!vmJob || !vmJob.server_uuid) {
            cb('ERROR - create vm job missing server_uuid field');
            return;
        }

        target_server_uuid = vmJob.server_uuid;
        record.target_server_uuid = target_server_uuid;

        cb(null, 'OK - reservation provisioned successfully to server ' +
            target_server_uuid);
    });
}


/*
 * Set up the cnapi receive request.
 */
function setupCnapiReceiveRequest(job, cb) {
    var action = job.params.migrationTask.action;
    var record = job.params.migrationTask.record;

    if (action === 'start') {
        cb(null, 'OK - not applicable for action ' + action);
        return;
    }

    assert.string(record.target_server_uuid, 'record.target_server_uuid');

    job.endpoint = '/servers/' +
                   record.target_server_uuid + '/vms/' +
                   job.params.vm_uuid + '/migrate-receive';
    job.action = 'migrate-receive';
    // job.server_uuid = record.target_server_uuid;

    // Used to keep the task result around.
    job.store_task_result_in_attribute = 'target_cn_result';

    cb(null, 'OK - second request has been setup');
}


function migration_store_process_details(job, cb) {
    var action = job.params.migrationTask.action;

    if (action === 'start') {
        cb(null, 'OK - not applicable for action ' + action);
        return;
    }

    var record = job.params.migrationTask.record;
    var progressHistory = record.progress_history;
    var progressEntry = progressHistory[job.params.migrationTask.progressIdx];
    var task_event;

    /* Store source CN process. */
    if (job.source_cn_result && job.source_cn_result.history &&
            job.source_cn_result.history.length > 0 &&
            job.source_cn_result.history[0].name === 'finish' &&
            job.source_cn_result.history[0].event) {

        task_event = job.source_cn_result.history[0].event;
        record.source_process_details = {
            pid: task_event.pid,
            ppid: task_event.pid,
            host: task_event.host,
            port: task_event.port
        };
    }

    /* Store target CN process. */
    if (job.target_cn_result && job.target_cn_result.history &&
            job.target_cn_result.history.length > 0 &&
            job.target_cn_result.history[0].name === 'finish' &&
            job.target_cn_result.history[0].event) {

        task_event = job.target_cn_result.history[0].event;
        record.target_process_details = {
            pid: task_event.pid,
            ppid: task_event.pid,
            host: task_event.host,
            port: task_event.port
        };
    }

    // Update progress entry.
    progressEntry.current_progress = 10;

    // Keep a running history for the record (debugging purposes).
    job.params.migrationTask.recordHistory.push(record);

    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: { 'x-request-id': job.params['x-request-id'] },
        url: vmapiUrl
    });
    var url = '/migrations/' + job.params.vm_uuid + '/store';

    rawVmapi.post(url, record, function _storeMigrationRecordCb(err, req, res) {
        if (err) {
            job.log.error({err: err}, 'Unable to store migration record: ' +
                err);
            cb(err);
            return;
        }

        // TODO: Store ETag?
        job.params.migrationTask.record = record;

        if (record.source_process_details.pid === -1) {
            job.log.error('No source CN PID, last task result: %j',
                job.source_cn_result);
            cb('Error - no source CN process PID returned from cnapi task');
            return;
        }

        if (record.target_process_details.pid === -1) {
            job.log.error('No target CN PID, last task result: %j',
                job.target_cn_result);
            cb('Error - no target CN process PID returned from cnapi task');
            return;
        }

        cb(null, 'OK - stored the process details in the migration record');
    });
}


function migration_store_task_success(job, cb) {
    var action = job.params.migrationTask.action;
    var record = job.params.migrationTask.record;
    var progressHistory = record.progress_history;
    var progressEntry = progressHistory[job.params.migrationTask.progressIdx];
    var finishedTimestamp = (new Date()).toISOString();

    // Update progress entry.
    progressEntry.current_progress = progressEntry.total_progress;
    progressEntry.finished_timestamp = finishedTimestamp;
    progressEntry.state = 'success';

    // Update record.
    record.finished_timestamp = finishedTimestamp;
    if (action === 'sync') {
        assert.number(record.num_sync_phases, 'record.num_sync_phases');
        record.num_sync_phases += 1;
    }

    if (action === 'abort') {
        record.state = 'aborted';
    } else if (action === 'switch') {
        record.state = 'successful';
    } else {
        record.state = 'paused';
    }

    // Clear out the cn-agent process details.
    record.source_process_details = {
        pid: -1,
        ppid: -1,
        host: '',
        port: -1
    };
    record.target_process_details = {
        pid: -1,
        ppid: -1,
        host: '',
        port: -1
    };

    // Keep a running history for the record (debugging purposes).
    job.params.migrationTask.recordHistory.push(record);

    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: { 'x-request-id': job.params['x-request-id'] },
        url: vmapiUrl
    });
    var url = '/migrations/' + job.params.vm_uuid + '/store';

    rawVmapi.post(url, record, function _storeRecordCb(err, req, res) {
        if (err) {
            job.log.error({err: err}, 'Unable to store migration record: ' +
                err);
            cb(err);
            return;
        }

        // TODO: Store ETag?
        job.params.migrationTask.record = record;

        cb(null, 'OK - stored the finished migration record');
    });
}


/*
 * Post back to vmapi that the migration failed. It will be up to vmapi to
 * go and clean up any associated items (provisioned vms, running processes,
 * etc...)
 */
function migration_store_failure(job, cb) {
    var action = job.params.migrationTask.action;
    var record = job.params.migrationTask.record;

    if (!record) {
        cb(null, 'OK - No migration record to store');
        return;
    }

    var progressHistory = record.progress_history;
    var progressEntry = progressHistory[job.params.migrationTask.progressIdx];
    var finishedTimestamp = (new Date()).toISOString();
    var taskErrorMsg;

    if (job.chain_results && job.chain_results.length > 0) {
        var lastTask = job.chain_results.slice(-1)[0];
        if (lastTask.error) {
            taskErrorMsg = lastTask.error;
            record.error += ' - ' + taskErrorMsg;
        }
    }

    // Update record.
    record.state = 'failed';
    record.finished_timestamp = finishedTimestamp;
    record.error = 'failed to ' + action + ' migration instance';

    // Update progress entry.
    if (progressEntry) {
        progressEntry.finished_timestamp = finishedTimestamp;
        progressEntry.state = 'failed';
        if (taskErrorMsg) {
            progressEntry.error = taskErrorMsg;
        }
    }

    // Keep a running history for the record (debugging purposes).
    if (!Array.isArray(job.params.migrationTask.recordHistory)) {
        job.params.migrationTask.recordHistory = [];
    }
    job.params.migrationTask.recordHistory.push(record);

    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: { 'x-request-id': job.params['x-request-id'] },
        url: vmapiUrl
    });
    var url = '/migrations/' + job.params.vm_uuid + '/store';

    rawVmapi.post(url, record, function _createMigrationRecordCb(err) {
        if (err) {
            job.log.error({err: err}, 'Unable to store migration record: ' +
                err);
            cb(null, 'OK - but could not store the migration record');
            return;
        }

        cb(null, 'OK - stored record for failed migration action');
    });
}


var workflow = module.exports = {
    name: 'migrate-' + VERSION,
    version: VERSION,
    timeout: 1800,

    chain: [ {
        name: 'common.validate_params',
        timeout: 20,
        retry: 1,
        body: common.validateForZoneAction,
        modules: {}
    }, {
        name: 'migration_validate_task',
        timeout: 20,
        retry: 1,
        body: migration_validate_task,
        modules: { assert: 'assert-plus' }
    }, {
        name: 'common.setup_request',
        timeout: 30,
        retry: 1,
        body: setupRequest,
        modules: {}
    }, {
        name: 'cnapi.acquire_vm_ticket',
        timeout: 120,
        retry: 1,
        body: common.acquireVMTicket,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'cnapi.wait_on_vm_ticket',
        timeout: 180,
        retry: 1,
        body: common.waitOnVMTicket,
        modules: { sdcClients: 'sdc-clients' }
    },

    /* Stop any old migration processes that are still running. */
    cleanup_source,
    cleanup_target,

    {
        name: 'migration_store_initial_record',
        timeout: 180,
        retry: 1,
        body: migration_store_initial_record,
        modules: {
            restify: 'restify'
        }
    }, {
        name: 'migration_provision_vm',
        timeout: 1200,
        retry: 1,
        body: migration_provision_vm,
        modules: {
            restify: 'restify',
            sdcClients: 'sdc-clients'
        }

    /* Setup the cn-agent source CN process. */
    }, {
        name: 'common.zoneAction',
        timeout: 300,
        retry: 1,
        body: common.zoneAction,
        modules: { restify: 'restify' }
    }, {
        name: 'common.wait_task',
        timeout: 300,
        retry: 1,
        body: common.waitTask,
        modules: { sdcClients: 'sdc-clients' }

    /* Setup the cn-agent target CN process. */
    }, {
        name: 'cnapi.setup_receive_process',
        timeout: 30,
        retry: 1,
        body: setupCnapiReceiveRequest,
        modules: { assert: 'assert-plus' }
    }, {
        name: 'common.zoneAction',
        timeout: 300,
        retry: 1,
        body: common.zoneAction,
        modules: { restify: 'restify' }
    }, {
        name: 'common.wait_task',
        timeout: 300,
        retry: 1,
        body: common.waitTask,
        modules: { sdcClients: 'sdc-clients' }

    /* Store migration source/target process information. */
    }, {
        name: 'migration_store_process_details',
        timeout: 180,
        retry: 1,
        body: migration_store_process_details,
        modules: { restify: 'restify' }
    },

    /* Sync workflow */
    sync,

    {
        name: 'migration_store_task_success',
        timeout: 180,
        retry: 1,
        body: migration_store_task_success,
        modules: {
            assert: 'assert-plus',
            restify: 'restify'
        }
    // }, {
    //     name: 'vmapi.put_vm',
    //     timeout: 60,
    //     retry: 1,
    //     body: common.putVm,
    //     modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'cnapi.release_vm_ticket',
        timeout: 60,
        retry: 1,
        body: common.releaseVMTicket,
        modules: { sdcClients: 'sdc-clients' }
    }],

    onerror: [ {
        name: 'migration_store_failure',
        timeout: 180,
        retry: 1,
        body: migration_store_failure,
        modules: { restify: 'restify' }
    },

    /* Stop migration processes that are still running. */
    cleanup_source,
    cleanup_target,

    {
        name: 'on_error.release_vm_ticket',
        modules: { sdcClients: 'sdc-clients' },
        body: common.releaseVMTicketIgnoringErr
    }],

    oncancel: [ {
        name: 'on_cancel.release_vm_ticket',
        modules: { sdcClients: 'sdc-clients' },
        body: common.releaseVMTicketIgnoringErr
    } ]
};
