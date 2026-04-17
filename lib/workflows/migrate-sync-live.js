/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2026 MNX Cloud, Inc.
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
var migrationLive = require('./vm-migration/live');


/*
 * Route-by-sync-count: live-begin on the first pass, live-sync after.
 * The record's num_sync_phases is incremented by the cold-migration
 * code's storeSuccess (which live also uses), so we read it at task
 * dispatch time.
 */
function routeToAgentCommand(job, cb) {
    var record = job.params.migrationTask.record;
    if (!record.num_sync_phases || record.num_sync_phases === 0) {
        job._liveTask = migrationLive.tasks.liveBegin;
    } else {
        job._liveTask = migrationLive.tasks.liveSync;
    }
    cb();
}

function dispatchLiveTask(job, cb) {
    // We indirect through _liveTask so the single workflow chain can
    // host either a first-time begin or an incremental sync.  The
    // underlying task bodies share the same CNAPI call shape (only
    // the action verb differs) so this dispatch is safe.
    job._liveTask.body(job, cb);
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

        /* Decide which agent command (begin vs sync) based on count. */
        {
            name: 'migrate-sync-live.route',
            timeout: 30,
            retry: 1,
            body: routeToAgentCommand
        },

        /* Fire the cn-agent task and wait on it. */
        common.tasks.setupForWaitTask,
        {
            name: 'migrate-sync-live.dispatch',
            timeout: 60 * 60,
            retry: 1,
            body: dispatchLiveTask,
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
