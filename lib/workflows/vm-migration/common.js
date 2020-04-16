/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */


var assert = require('assert-plus');
var restify = require('restify');


function validate(job, cb) {
    assert.object(job.params.vm, 'job.params.vm');
    assert.string(job.params.vm_uuid, 'job.params.vm_uuid');

    if (typeof (job.params.migrationTask) !== 'object') {
        cb('Error - no migrationTask object defined');
        return;
    }

    if (!job.params.migrationTask.action) {
        cb('Error - no migrationTask.action defined');
        return;
    }

    if (typeof (job.params.migrationTask.record) !== 'object') {
        cb('Error - no migrationTask.record object defined');
        return;
    }

    var action = job.params.migrationTask.action;
    var record = job.params.migrationTask.record;

    // Keep a running history of the record (for debugging purposes).
    job.migrationRecordHistory = [record];

    var VALID_MIGRATION_ACTIONS = [
        'abort',
        'begin',
        'pause',
        'rollback',
        'switch',
        'sync'
    ];

    if (VALID_MIGRATION_ACTIONS.indexOf(action) === -1) {
        cb('Error - invalid migration action: ' + action);
        return;
    }

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

    // For switch actions, validate that at least one successful sync operation
    // has been performed.
    if (action === 'switch' && !record.num_sync_phases) {
        cb('Error - must perform one "sync" operation before switching');
        return;
    }

    // Put the action in the job (provides info for cnapi ticket allocation).
    if (!job.action) {
        job.action = 'migration-' + action;
    }

    cb(null, 'OK - migration action "' + action + '" is valid, ' +
        'migration id: ' + record.id);
}


function disallowRetry(job, cb) {
    job.migrationDisallowRetry = true;
    cb(null, 'OK - disallowing retry of this phase');
}

/*
 * Sets up the cnapi source process.
 *
 * Take a look at common.zoneAction. Here you can set parameters such as:
 * - request endpoint (usually the VM endpoint)
 * - jobid (so CNAPI can post status updates back to the job info object)
 * - requestMethod
 * - expects (if you want to check a specific running status of the machine)
 */
function setupCnapiSource(job, cb) {
    var action = job.params.migrationTask.action;
    var record = job.params.migrationTask.record;

    job.endpoint = '/servers/' +
                   record.source_server_uuid + '/vms/' +
                   record.vm_uuid + '/migrate';
    job.params.action = action;
    job.params.jobid = job.uuid;
    job.expects = 'running';
    job.action = 'migrate';
    job.server_uuid = job.params['server_uuid'];

    // Used to keep the task result around.
    job.store_task_finish_event_in_attribute = 'source_cn_result';

    // Not using sdc-clients to allow calling generic POST actions without
    // explicitly saying: startVm, stopVm, etc
    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: {'x-request-id': job.params['x-request-id']}
    });

    function callback(err, req, res, task) {
        if (err) {
            cb(err);
            return;
        }

        job.taskId = task.id;
        cb(null, 'Migration source task id: ' + task.id + ' queued to CNAPI!');
    }

    cnapi.post(job.endpoint, job.params, callback);
}


function removeSourceZfsQuota(job, cb) {
    if (job.params.vm.brand !== 'bhyve') {
        job.params.skip_zone_action = true;
        cb(null, 'OK - not necessary for ' + job.params.vm.brand + ' zone');
        return;
    }

    var record = job.params.migrationTask.record;

    assert.string(record.source_server_uuid, 'record.source_server_uuid');
    assert.object(record.sourceFilesystemDetails,
        'record.sourceFilesystemDetails');

    if (!record.sourceFilesystemDetails.mustRemoveQuotaForSync) {
        job.params.skip_zone_action = true;
        cb(null, 'OK - do not need to remove quota');
        return;
    }

    job.endpoint = '/servers/' +
                   record.source_server_uuid + '/vms/' +
                   record.vm_uuid + '/migrate';
    job.action = 'migrate';
    job.params.action = 'remove-zfs-quota';
    job.params.skip_zone_action = false;

    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: {'x-request-id': job.params['x-request-id']}
    });

    function callback(err, req, res, task) {
        if (err) {
            cb(err);
            return;
        }

        job.taskId = task.id;
        cb(null, 'Migration task id: ' + task.id + ' queued to CNAPI!');
    }

    cnapi.post(job.endpoint, job.params, callback);
}


function removeTargetZfsQuota(job, cb) {
    if (job.params.vm.brand !== 'bhyve') {
        job.params.skip_zone_action = true;
        cb(null, 'OK - not necessary for ' + job.params.vm.brand + ' zone');
        return;
    }

    var record = job.params.migrationTask.record;

    assert.string(record.target_server_uuid, 'record.target_server_uuid');
    assert.object(record.targetFilesystemDetails,
        'record.targetFilesystemDetails');

    if (!record.targetFilesystemDetails.mustRemoveQuotaForSync) {
        job.params.skip_zone_action = true;
        cb(null, 'OK - do not need to remove quota');
        return;
    }

    job.endpoint = '/servers/' +
                   record.target_server_uuid + '/vms/' +
                   record.target_vm_uuid + '/migrate';
    job.action = 'migrate';
    job.params.action = 'remove-zfs-quota';
    job.params.skip_zone_action = false;

    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: {'x-request-id': job.params['x-request-id']}
    });

    function callback(err, req, res, task) {
        if (err) {
            cb(err);
            return;
        }

        job.taskId = task.id;
        cb(null, 'Migration task id: ' + task.id + ' queued to CNAPI!');
    }

    cnapi.post(job.endpoint, job.params, callback);
}


function restoreSourceZfsQuota(job, cb) {
    if (job.params.vm.brand !== 'bhyve') {
        job.params.skip_zone_action = true;
        cb(null, 'OK - not necessary for ' + job.params.vm.brand + ' zone');
        return;
    }

    var record = job.params.migrationTask.record;

    assert.string(record.source_server_uuid, 'record.source_server_uuid');
    assert.object(record.sourceFilesystemDetails,
        'record.sourceFilesystemDetails');

    if (!record.sourceFilesystemDetails.mustRemoveQuotaForSync) {
        job.params.skip_zone_action = true;
        cb(null, 'OK - do not need to restore quota');
        return;
    }

    job.endpoint = '/servers/' +
                   record.source_server_uuid + '/vms/' +
                   record.vm_uuid + '/migrate';
    job.action = 'migrate';
    job.params.action = 'restore-zfs-quota';
    job.params.skip_zone_action = false;

    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: {'x-request-id': job.params['x-request-id']}
    });

    function callback(err, req, res, task) {
        if (err) {
            cb(err);
            return;
        }

        job.taskId = task.id;
        cb(null, 'Migration task id: ' + task.id + ' queued to CNAPI!');
    }

    cnapi.post(job.endpoint, job.params, callback);
}


function restoreTargetZfsQuota(job, cb) {
    if (job.params.vm.brand !== 'bhyve') {
        job.params.skip_zone_action = true;
        cb(null, 'OK - not necessary for ' + job.params.vm.brand + ' zone');
        return;
    }

    var record = job.params.migrationTask.record;

    assert.string(record.target_server_uuid, 'record.target_server_uuid');
    assert.object(record.targetFilesystemDetails,
        'record.targetFilesystemDetails');

    if (!record.targetFilesystemDetails.mustRemoveQuotaForSync) {
        job.params.skip_zone_action = true;
        cb(null, 'OK - do not need to restore quota');
        return;
    }

    job.endpoint = '/servers/' +
                   record.target_server_uuid + '/vms/' +
                   record.target_vm_uuid + '/migrate';
    job.action = 'migrate';
    job.params.action = 'restore-zfs-quota';
    job.params.skip_zone_action = false;

    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: {'x-request-id': job.params['x-request-id']}
    });

    function callback(err, req, res, task) {
        if (err) {
            cb(err);
            return;
        }

        job.taskId = task.id;
        cb(null, 'Migration task id: ' + task.id + ' queued to CNAPI!');
    }

    cnapi.post(job.endpoint, job.params, callback);
}


/*
 * Set up the cnapi receiver process on the target server.
 *
 * Take a look at common.zoneAction. Here you can set parameters such as:
 * - request endpoint (usually the VM endpoint)
 * - jobid (so CNAPI can post status updates back to the job info object)
 * - requestMethod
 * - expects (if you want to check a specific running status of the machine)
 */
function setupCnapiTarget(job, cb) {
    var action = job.params.migrationTask.action;
    var record = job.params.migrationTask.record;

    if (action === 'begin') {
        cb(null, 'OK - not applicable for action ' + action);
        return;
    }

    assert.string(record.target_server_uuid, 'record.target_server_uuid');

    job.endpoint = '/servers/' +
                   record.target_server_uuid + '/vms/' +
                   record.target_vm_uuid + '/migrate';
    job.action = 'migrate';
    job.params.action = 'receive';

    // Used to keep the task result around.
    job.store_task_finish_event_in_attribute = 'target_cn_result';

    // Not using sdc-clients to allow calling generic POST actions without
    // explicitly saying: startVm, stopVm, etc
    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: {'x-request-id': job.params['x-request-id']}
    });

    function callback(err, req, res, task) {
        if (err) {
            cb(err);
            return;
        }

        job.taskId = task.id;
        cb(null, 'Migration target task id: ' + task.id + ' queued to CNAPI!');
    }

    cnapi.post(job.endpoint, job.params, callback);
}


function setSourceVmAutoboot(job, cb) {
    var record = job.params.migrationTask.record;

    assert.object(job.params.vm, 'job.params.vm');
    assert.uuid(record.source_server_uuid, 'record.source_server_uuid');
    assert.uuid(record.vm_uuid, 'record.vm_uuid');

    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    var url = '/servers/' +
        record.source_server_uuid + '/vms/' +
        record.vm_uuid + '/migrate';
    var payload = {
        action: 'set-autoboot',
        migrationTask: job.params.migrationTask,
        vm_uuid: record.vm_uuid,
        value: (job.params.vm.autoboot ? 'true' : 'false')
    };

    cnapi.post(url, payload, function _setAutobootCb(err, req, res, task) {
        if (err) {
            cb(err);
            return;
        }

        job.taskId = task.id;
        cb(null, 'OK - task id: ' + task.id + ' queued to CNAPI!');
    });
}


/**
 * Set the record state to 'running'.
 */
function setRecordStateRunning(job, cb) {
    var record = job.params.migrationTask.record;
    delete record.error;

    record.state = 'running';

    // There is no progress entry yet.
    job.params.migrationTask.progressIdx = -1;

    // Keep a running history of the record (debugging purposes).
    job.migrationRecordHistory.push(record);

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


/**
 * Create a new progress entry, add it to the record and then save the record.
 */
function storeInitialRecord(job, cb) {
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
        host: '',
        port: -1
    };
    record.target_process_details = {
        pid: -1,
        host: '',
        port: -1
    };

    // Create a progress entry.
    switch (action) {
        case 'begin':
            phase = 'begin';
            message = 'reserving instance';
            break;
        case 'abort':
            message = 'aborting migration';
            break;
        case 'pause':
            message = 'pausing migration';
            break;
        case 'rollback':
            message = 'reverting migration';
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
        type: 'progress',
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
    // Keep a running history of the record (debugging purposes).
    job.migrationRecordHistory.push(record);

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


function storeProcessDetails(job, cb) {
    var action = job.params.migrationTask.action;

    if (action === 'begin') {
        cb(null, 'OK - not applicable for action ' + action);
        return;
    }

    var record = job.params.migrationTask.record;
    var progressHistory = record.progress_history;
    var progressEntry = progressHistory[job.params.migrationTask.progressIdx];

    /* Store source CN process. */
    if (job.source_cn_result) {
        record.source_process_details = {
            pid: job.source_cn_result.pid,
            host: job.source_cn_result.host,
            port: job.source_cn_result.port
        };
    }

    /* Store target CN process. */
    if (job.target_cn_result) {
        record.target_process_details = {
            pid: job.target_cn_result.pid,
            host: job.target_cn_result.host,
            port: job.target_cn_result.port
        };
    }

    // Update progress entry.
    progressEntry.current_progress = 10;

    // Keep a running history of the record (debugging purposes).
    job.migrationRecordHistory.push(record);

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


/**
 * Save the current migration record as is.
 */
function storeRecord(job, cb) {
    var record = job.params.migrationTask.record;

    // Keep a running history of the record (debugging purposes).
    job.migrationRecordHistory.push(record);

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


function storeSuccess(job, cb) {
    var action = job.params.migrationTask.action;
    var record = job.params.migrationTask.record;
    var progressHistory = record.progress_history;
    var progressEntry = progressHistory[job.params.migrationTask.progressIdx];
    var finishedTimestamp = (new Date()).toISOString();

    // Update progress entry.
    progressEntry.current_progress = progressEntry.total_progress;
    progressEntry.finished_timestamp = finishedTimestamp;
    progressEntry.state = 'successful';

    // Update record.
    record.finished_timestamp = finishedTimestamp;
    if (action === 'sync') {
        assert.number(record.num_sync_phases, 'record.num_sync_phases');
        record.num_sync_phases += 1;
    }

    if (action === 'switch' || action === 'abort' || action === 'rollback') {
        record.state = 'successful';
    } else if (record.automatic && (action === 'begin' || action === 'sync')) {
        record.state = 'running';
    } else if (job.params.is_migration_subtask) {
        record.state = 'running';
    } else {
        record.state = 'paused';
    }

    // Clear out the cn-agent process details.
    record.source_process_details = {
        pid: -1,
        host: '',
        port: -1
    };
    record.target_process_details = {
        pid: -1,
        host: '',
        port: -1
    };

    // Keep a running history of the record (debugging purposes).
    job.migrationRecordHistory.push(record);

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
function storeFailure(job, cb) {
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
        }
    }

    // Update record.
    record.state = 'failed';
    record.finished_timestamp = finishedTimestamp;
    record.error = 'failed to ' + action + ' migration instance';
    if (taskErrorMsg) {
        record.error += ' - ' + taskErrorMsg;
    }

    // Update progress entry.
    if (!progressEntry) {
        progressEntry =  {
            type: 'progress',
            phase: action,
            state: 'failed',
            started_timestamp: new Date(job.started).toISOString(),
            current_progress: 2,
            total_progress: 100,
            job_uuid: job.uuid
        };
        progressHistory.push(progressEntry);
    }
    progressEntry.finished_timestamp = finishedTimestamp;
    progressEntry.state = 'failed';
    if (taskErrorMsg) {
        progressEntry.error = taskErrorMsg;
    }

    if (job.migrationDisallowRetry) {
        progressEntry.disallowRetry = true;
    } else if (record.phase === 'switch') {
        // Rollback to state 'sync' - this will allow another attempt at the
        // switch phase.
        record.phase = 'sync';
    }

    // Keep a running history of the record (debugging purposes).
    if (!Array.isArray(job.migrationRecordHistory)) {
        job.migrationRecordHistory = [];
    }
    job.migrationRecordHistory.push(record);

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


module.exports = {
    tasks: {
        disallowRetry: {
            name: 'migration.disallowRetry',
            timeout: 30,
            retry: 1,
            body: disallowRetry,
            modules: {}
        },
        removeSourceZfsQuota: {
            name: 'migration.removeSourceZfsQuota',
            timeout: 300,
            retry: 1,
            body: removeSourceZfsQuota,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        removeTargetZfsQuota: {
            name: 'migration.removeTargetZfsQuota',
            timeout: 300,
            retry: 1,
            body: removeTargetZfsQuota,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        restoreSourceZfsQuota: {
            name: 'migration.restoreSourceZfsQuota',
            timeout: 300,
            retry: 1,
            body: restoreSourceZfsQuota,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        restoreTargetZfsQuota: {
            name: 'migration.restoreTargetZfsQuota',
            timeout: 300,
            retry: 1,
            body: restoreTargetZfsQuota,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        setupCnapiSource: {
            name: 'migration.setupCnapiSource',
            timeout: 300,
            retry: 1,
            body: setupCnapiSource,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        setRecordStateRunning: {
            name: 'migration.setRecordStateRunning',
            timeout: 300,
            retry: 1,
            body: setRecordStateRunning,
            modules: {
                restify: 'restify'
            }
        },
        setupCnapiTarget: {
            name: 'migration.setupCnapiTarget',
            timeout: 300,
            retry: 1,
            body: setupCnapiTarget,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        setSourceVmAutoboot: {
            name: 'migration.rollback.setSourceVmAutoboot',
            timeout: 300,
            // retry: 1,
            body: setSourceVmAutoboot,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        storeFailure: {
            name: 'migration.storeFailure',
            timeout: 180,
            retry: 1,
            body: storeFailure,
            modules: {
                restify: 'restify'
            }
        },
        storeInitialRecord: {
            name: 'migration.storeInitialRecord',
            timeout: 180,
            retry: 1,
            body: storeInitialRecord,
            modules: {
                restify: 'restify'
            }
        },
        storeProcessDetails: {
            name: 'migration.storeProcessDetails',
            timeout: 180,
            retry: 1,
            body: storeProcessDetails,
            modules: {
                restify: 'restify'
            }
        },
        storeRecord: {
            name: 'migration.storeRecord',
            timeout: 180,
            retry: 1,
            body: storeRecord,
            modules: {
                restify: 'restify'
            }
        },
        storeSuccess: {
            name: 'migration.storeSuccess',
            timeout: 180,
            retry: 1,
            body: storeSuccess,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        validate: {
            name: 'migration.validate',
            timeout: 20,
            retry: 1,
            body: validate,
            modules: {
                assert: 'assert-plus'
            }
        }
    }
};
