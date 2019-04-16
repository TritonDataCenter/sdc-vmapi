/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */


var restify = require('restify');

var wfapiUrl;


function validateSyncIsRunning(job, cb) {
    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: { 'x-request-id': job.params['x-request-id'] },
        url: vmapiUrl
    });
    var url = '/migrations/' + job.params.vm_uuid + '?format=raw';

    rawVmapi.get(url, function _getRecordCb(err, req, res, record) {
        if (err) {
            job.log.error({err: err}, 'Unable to retrieve migration record: ' +
                err);
            cb(err);
            return;
        }

        var progressHistory = record.progress_history;
        var progressEntries = progressHistory.filter(function _filtSync(entry) {
            return entry.state === 'running' && entry.phase === 'sync';
        });

        if (progressEntries.length === 0) {
            cb(new Error('No migration sync phase is currently running'));
            return;
        }

        if (progressEntries.length > 1) {
            cb(new Error('Multiple migration sync phases are running'));
            return;
        }

        job.params.migrationTask.record = record;
        job.params.migrationTask.progressIdx =
            progressHistory.indexOf(progressEntries[0]);

        cb(null, 'OK - migration sync is currently running');
    });
}


function cancelSyncWorkflow(job, cb) {
    var record = job.params.migrationTask.record;

    var progressEntry = record.progress_history[
        job.params.migrationTask.progressIdx];
    var jobUuid = progressEntry.job_uuid;

    var wfapi = restify.createJsonClient({
        url: wfapiUrl,
        headers: {'x-request-id': job.params['x-request-id']}
    });

    wfapi.post('/jobs/' + jobUuid + '/cancel', function (err, req, res) {
        if (err) {
            job.log.error({err: err}, 'Unable to cancel migration sync job: ' +
                err);
            cb(err);
            return;
        }

        cb(null, 'OK - migration sync workflow job was canceled');
    });
}


function markSyncPaused(job, cb) {
    var record = job.params.migrationTask.record;

    var progressEntry = record.progress_history[
        job.params.migrationTask.progressIdx];

    // Update progress entry.
    progressEntry.error = '';
    progressEntry.state = 'paused';
    progressEntry.finished_timestamp = (new Date()).toISOString();

    // Update record.
    record.error = '';
    record.state = 'paused';

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

    cb(null, 'OK - changed migration record to paused state');
}


module.exports = {
    tasks: {
        validateSyncIsRunning: {
            name: 'migration.validateSyncIsRunning',
            timeout: 180,
            retry: 1,
            body: validateSyncIsRunning,
            modules: {
                restify: 'restify'
            }
        },
        cancelSyncWorkflow: {
            name: 'migration.cancelSyncWorkflow',
            timeout: 600,
            retry: 1,
            body: cancelSyncWorkflow,
            modules: {
                restify: 'restify'
            }
        },
        markSyncPaused: {
            name: 'migration.dapi.markSyncPaused',
            timeout: 30,
            retry: 1,
            body: markSyncPaused,
            modules: {
            }
        }
    }
};
