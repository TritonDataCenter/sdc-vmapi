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

var common = require('./job-common');
var cleanupSource = require('./vm-migration/cleanup_source');
var cleanupTarget = require('./vm-migration/cleanup_target');
var migrationCommon = require('./vm-migration/common');
var pause = require('./vm-migration/pause');

var VERSION = '1.0.0';

var workflow = module.exports = {
    name: 'migrate-pause-' + VERSION,
    version: VERSION,
    timeout: 1800,

    chain: [
        common.tasks.validateForZoneAction,

        migrationCommon.tasks.validate,

        common.tasks.acquireVMTicket,
        common.tasks.waitOnVMTicket,

        pause.tasks.validateSyncIsRunning,

        pause.tasks.cancelSyncWorkflow,

        /* Stop any old migration processes that are still running. */
        cleanupSource,
        cleanupTarget,

        pause.tasks.markSyncPaused,
        migrationCommon.tasks.storeRecord,

        common.tasks.releaseVMTicket
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
