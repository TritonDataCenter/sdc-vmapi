/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2026 Edgecast Cloud LLC.
 */

/*
 * migrate-sync-live: bhyve live-migration sync phase.
 *
 * The vmm-migrate-agent distinguishes between the FIRST data transfer
 * (command=migrate-begin, full zfs send) and subsequent incremental
 * passes (command=migrate-sync).  The cn-agent child
 * (machine-migrate-live.js) routes either based on the action verb
 * the workflow posts:
 *   - action=live-begin  first-time full send
 *   - action=live-sync   incremental send
 *
 * VMAPI decides which to use based on record.num_sync_phases: 0 means
 * this is the first sync → full send; >=1 means incremental.
 *
 * Unlike cold migration's sync, live sync does not set up cn-agent
 * send/receive children to pipe zfs between CNs — the
 * vmm-migrate-agent on each CN does that peer-to-peer over its own
 * TCP session (:4567 on each CN's admin network).  So the workflow
 * chain here is considerably shorter than migrate-sync.js.
 */

var common = require('./job-common');
var cleanupSource = require('./vm-migration/cleanup_source');
var cleanupTarget = require('./vm-migration/cleanup_target');
var migrationCommon = require('./vm-migration/common');


/*
 * Combined route + dispatch: the sync workflow hosts either the
 * first-time full zfs send (agent action `live-begin`) or an
 * incremental (`live-sync`).  Which one is determined by
 * record.num_sync_phases — 0 on the first pass, increments on
 * subsequent syncs via migrationCommon.tasks.storeSuccess.
 *
 * We do route+post in a single task body because workflow tasks
 * run in a sandboxed evalmachine and cannot `require` modules
 * outside their declared `modules` map.  Rather than ship two
 * cross-task bodies with shared state (`job._liveTask`), we inline
 * the small amount of logic and POST to CNAPI directly.
 */
function dispatchLiveSyncTask(job, cb) {
    /*
     * NOTE: `assert` and `restify` are injected by the workflow task
     * runner from the task's `modules:` map below — they are NOT
     * available via require() here because the body runs in a sandboxed
     * evalmachine that has no module system of its own.
     */
    var CNAPI_DISPATCH_TIMEOUT_MS = 60 * 1000;
    var record = job.params.migrationTask.record;

    // num_sync_phases is set as a number by storeSuccess on sync
    // completion; coerce defensively in case a past record was written
    // with the field unset or as a string (moray has no schema enforcement
    // on this attribute).  0 or missing → live-begin, >0 → live-sync.
    var syncPhasesRaw = record.num_sync_phases;
    var syncPhases = parseInt(syncPhasesRaw, 10);
    if (!Number.isFinite(syncPhases) || syncPhases < 0) {
        syncPhases = 0;
    }
    var action = syncPhases === 0 ? 'live-begin' : 'live-sync';

    assert.uuid(record.source_server_uuid, 'record.source_server_uuid');

    job.endpoint = '/servers/' + record.source_server_uuid +
        '/vms/' + record.vm_uuid + '/migrate';
    job.action = 'migrate';
    job.params.action = action;

    /*
     * live-begin is the one agent action that needs the target admin
     * IP as the `dest` argument to vmm-migrate-agent's migrate-begin
     * command.  The IP is stashed on the record by the begin
     * workflow's resolveAgentEndpoints task.
     */
    if (action === 'live-begin') {
        assert.string(record.target_admin_ip, 'record.target_admin_ip');
        job.params.target_admin_ip = record.target_admin_ip;
    }

    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: {'x-request-id': job.params['x-request-id']},
        connectTimeout: CNAPI_DISPATCH_TIMEOUT_MS,
        requestTimeout: CNAPI_DISPATCH_TIMEOUT_MS
    });

    cnapi.post(job.endpoint, job.params, function (err, req, res, task) {
        if (err) { cb(err); return; }
        job.taskId = task.id;
        cb(null, action + ' task queued to CNAPI: ' + task.id);
    });
}

var VERSION = '1.0.0';

var workflow = module.exports = {
    name: 'migrate-sync-live-' + VERSION,
    version: VERSION,
    timeout: 60 * 60 * 24, // 1 day — large disks can take a while

    chain: [
        common.tasks.validateForZoneAction,

        migrationCommon.tasks.validate,

        common.tasks.acquireVMTicket,
        common.tasks.waitOnVMTicket,

        /* Stop any old migration processes that are still running. */
        cleanupSource,
        cleanupTarget,

        migrationCommon.tasks.storeInitialRecord,

        common.tasks.releaseVMTicket,

        /* Fire the cn-agent task and wait on it. */
        common.tasks.setupForWaitTask,
        {
            name: 'migrate-sync-live.dispatch',
            timeout: 60 * 60,
            retry: 1,
            body: dispatchLiveSyncTask,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        common.tasks.waitTask,

        migrationCommon.tasks.storeSuccess
    ],

    onerror: [
        cleanupSource,
        cleanupTarget,
        migrationCommon.tasks.storeFailure,
        common.tasks.releaseVMTicketIgnoringErr
    ],

    oncancel: [
        cleanupSource,
        cleanupTarget,
        migrationCommon.tasks.storeFailure,
        common.tasks.releaseVMTicketIgnoringErr
    ]
};
