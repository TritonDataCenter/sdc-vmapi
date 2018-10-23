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
var uuidv4; // Provided by workflow.

var common = require('./job-common');
var watch = require('./vm-migration/watch');

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
    job.endpoint = '/servers/' +
                   job.params['server_uuid'] + '/vms/' +
                   job.params['vm_uuid'] + '/migrate';
    job.params.jobid = job.uuid;
    job.requestMethod = 'post';
    job.expects = 'running';
    job.action = 'migrate';
    job.server_uuid = job.params['server_uuid'];

    // Used to keep the previous task information around.
    job.store_task_result = true;

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
            'action',
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

        if (action === 'start' || action === 'full') {
            // When starting a new migration - there should not be a previous
            // migration record, or if there is it should be an aborted record.
            // If it an aborted migration - then we'll simply overwrite the
            // record with a new one.
            if (record.state !== 'aborted') {
                cb('Error - migration already exists for this instance');
                return;
            }

            // Delete the old record - so a new one will be created.
            record = null;
            delete job.params.migrationTask.record;
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
function migration_store_record(job, cb) {
    var action = job.params.migrationTask.action;
    var jobHistory;
    var message;
    var phase = action;
    var progressEntry;
    var progressHistory;
    var record;
    var startTimestamp = (new Date()).toISOString();

    if (action === 'start' || action === 'full') {
        // Create a new record.
        jobHistory = [];
        progressHistory = [];
        record = {
            action: action,
            automatic: (action === 'full'),
            created_timestamp: startTimestamp,
            id: uuidv4(),
            phase: 'start',
            progress_history: progressHistory,
            source_server_uuid: job.params.vm.server_uuid,
            started_timestamp: startTimestamp,
            state: 'running',
            vm_uuid: job.params.vm.uuid
        };
    } else {
        // Add record to the existing progress array.
        record = job.params.migrationTask.record;
        jobHistory = record.job_history;
        if (!jobHistory) {
            jobHistory = [];
            record.job_history = jobHistory;
        }
        progressHistory = record.progress_history;
        if (!progressHistory) {
            progressHistory = [];
            record.progress_history = progressHistory;
        }
    }

    record.job_uuid = job.uuid;
    jobHistory.push(job.uuid);

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

    progressEntry = {
        message: message,
        phase: phase,
        state: 'running',
        start_timestamp: startTimestamp,
        current_progress: 1,
        total_progress: 100
    };

    job.params.migrationTask.progressIdx = progressHistory.length;
    progressHistory.push(progressEntry);
    // Keep a running history for the record (debugging purposes).
    job.params.migrationTask.recordHistory = [record];

    // Store the migration record.
    var postData = {
        migrationRecord: record
    };
    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: { 'x-request-id': job.params['x-request-id'] },
        url: vmapiUrl
    });
    var url = '/vms/' + job.params.vm_uuid +
        '?action=migrate&migration_action=storeMigrationRecord';

    rawVmapi.post(url, postData,
            function _createMigrationRecordCb(err, req, res, migrationRecord) {
        if (err) {
            cb(err);
            return;
        }

        // TODO: Store ETag?
        job.params.migrationTask.record = migrationRecord;

        cb(null, 'OK - stored migration record, id ' + migrationRecord.id);
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

    vmapi.createVmAndWait(vmPayload, function _onCreateVmCb(vmErr) {
        if (vmErr) {
            var record = job.params.migrationTask.record;
            var progressEntry = record.progress_history[
                job.params.migrationTask.progressIdx];

            progressEntry.message = 'reserving instance failed - '
                + vmErr.message;
            cb(vmErr);
            return;
        }

        cb(null, 'OK - reservation provisioned successfully');
    });
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

    record.process_details = {
        pid: -1,
        host: '',
        port: -1
    };

    if (job.task_result && job.task_result.history &&
            job.task_result.history.length > 0 &&
            job.task_result.history[0].name === 'finish' &&
            job.task_result.history[0].event) {

        task_event = job.task_result.history[0].event;
        record.process_details = {
            pid: task_event.pid,
            host: task_event.host,
            port: task_event.port
        };
    }

    // Update progress entry.
    progressEntry.current_progress = 10;

    // Keep a running history for the record (debugging purposes).
    job.params.migrationTask.recordHistory.push(record);

    var postData = {
        migrationRecord: record
    };
    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: { 'x-request-id': job.params['x-request-id'] },
        url: vmapiUrl
    });
    var url = '/vms/' + job.params.vm_uuid +
        '?action=migrate&migration_action=storeMigrationRecord';

    rawVmapi.post(url, postData,
            function _storeMigrationRecordCb(err, req, res, migrationRecord) {
        if (err) {
            job.log.error({err: err}, 'Unable to store migration record: ' +
                err);
            cb(err);
            return;
        }

        // TODO: Store ETag?
        job.params.migrationTask.record = migrationRecord;

        if (record.process_details.pid === -1) {
            job.log.error('No PID, last task result: %j', job.task_result);
            cb('Error - no process PID returned from cnapi task');
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
    var endTimestamp = (new Date()).toISOString();

    // Update progress entry.
    progressEntry.current_progress = progressEntry.total_progress;
    progressEntry.end_timestamp = endTimestamp;
    progressEntry.state = 'success';

    // Update record.
    record.finished_timestamp = endTimestamp;

    if (action === 'abort') {
        record.state = 'aborted';
    } else if (action === 'switch') {
        record.state = 'successful';
    } else {
        record.state = 'paused';
    }

    // Keep a running history for the record (debugging purposes).
    job.params.migrationTask.recordHistory.push(record);

    var postData = {
        migrationRecord: record
    };
    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: { 'x-request-id': job.params['x-request-id'] },
        url: vmapiUrl
    });
    var url = '/vms/' + job.params.vm_uuid +
        '?action=migrate&migration_action=storeMigrationRecord';

    rawVmapi.post(url, postData,
            function _createMigrationRecordCb(err, req, res, migrationRecord) {
        if (err) {
            job.log.error({err: err}, 'Unable to store migration record: ' +
                err);
            cb(err);
            return;
        }

        // TODO: Store ETag?
        job.params.migrationTask.record = migrationRecord;

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
    var endTimestamp = (new Date()).toISOString();

    // Update progress entry.
    progressEntry.end_timestamp = endTimestamp;
    progressEntry.state = 'failed';
    // Update record.
    record.state = 'failed';
    record.finished_timestamp = endTimestamp;
    record.error = 'failed to ' + action + ' migration instance';
    if (job.chain_results && job.chain_results.length > 0) {
        var lastTask = job.chain_results.slice(-1)[0];
        if (lastTask.error) {
            record.error += ' - ' + lastTask.error;
            progressEntry.error = lastTask.error;
        }
    }
    // Keep a running history for the record (debugging purposes).
    job.params.migrationTask.recordHistory.push(record);

    var postData = {
        migrationRecord: record
    };
    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: { 'x-request-id': job.params['x-request-id'] },
        url: vmapiUrl
    });
    var url = '/vms/' + job.params.vm_uuid +
        '?action=migrate&migration_action=storeMigrationRecord';

    rawVmapi.post(url, postData,
            function _createMigrationRecordCb(err) {
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
        timeout: 60,
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
        name: 'migration_store_record',
        timeout: 180,
        retry: 3,
        body: migration_store_record,
        modules: {
            restify: 'restify',
            uuidv4: 'uuid/v4'
        }
    }, {
        name: 'migration_provision_vm',
        timeout: 1200,
        retry: 2,
        body: migration_provision_vm,
        modules: {
            restify: 'restify',
            sdcClients: 'sdc-clients'
        }
    }, {
        name: 'common.zoneAction',
        timeout: 300,
        retry: 2,
        body: common.zoneAction,
        modules: { restify: 'restify' }
    }, {
        name: 'common.wait_task',
        timeout: 300,
        retry: 1,
        body: common.waitTask,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'migration_store_process_details',
        timeout: 180,
        retry: 3,
        body: migration_store_process_details,
        modules: { restify: 'restify' }
    },

    // Watch workflow
    watch,

    {
        name: 'migration_store_task_success',
        timeout: 180,
        retry: 3,
        body: migration_store_task_success,
        modules: { restify: 'restify' }
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
        retry: 3,
        body: migration_store_failure,
        modules: { restify: 'restify' }
    }, {
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
