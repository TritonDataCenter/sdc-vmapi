/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2026 MNX Cloud, Inc.
 */

/*
 * migrate-switch-live: the bhyve live-migration cutover.
 *
 * Where cold's migrate-switch stops the source VM, runs a final sync,
 * and starts the target — live's switch hands everything to the
 * vmm-migrate-agent's `migrate-switch` command via cn-agent.  That
 * single agent command drives:
 *
 *   1. Baseline RAM pass (source still running).
 *   2. Convergence iterations (dirty-page pre-copy).
 *   3. Source pause (the real downtime begins).
 *   4. Final incremental zfs send + RAM dirty-pass.
 *   5. bhyve state export → import on dest.
 *   6. Activate vCPUs on dest, vm_resume_instance.
 *   7. Gratuitous ARP from GZ agent to re-converge L2.
 *
 * The workflow chain is therefore much shorter than cold's switch:
 * pre-checks, acquire the ticket, post the live-switch action, wait,
 * update VMAPI's authoritative server_uuid on success, cleanup.
 *
 * Rollback semantics: on failure before the agent reports success, the
 * source VM is still paused-or-running on the original CN and the
 * record stays recoverable via migrate-rollback-live.  The agent
 * itself tries hard to keep the source in a resumable state if the
 * cutover fails.
 */

var common = require('./job-common');
var migrationCommon = require('./vm-migration/common');
var migrationLive = require('./vm-migration/live');
var modSwitch = require('./vm-migration/switch');

var VERSION = '1.0.0';

var workflow = module.exports = {
    name: 'migrate-switch-live-' + VERSION,
    version: VERSION,
    timeout: 60 * 60, // 1 hour — covers large convergence windows

    chain: [
        common.tasks.validateForZoneAction,

        migrationCommon.tasks.validate,

        common.tasks.acquireVMTicket,
        common.tasks.waitOnVMTicket,
        migrationCommon.tasks.setRecordStateRunning,

        /* Cutover: fire live-switch and wait for the agent to finish. */
        common.tasks.setupForWaitTask,
        migrationLive.tasks.liveSwitch,
        common.tasks.waitTask,

        /* Past this point retries are unsafe — the dest VM is live. */
        migrationCommon.tasks.disallowRetry,

        /*
         * Flip VMAPI's authoritative server_uuid to the target so
         * subsequent VMAPI operations route there.  Same task cold
         * migration uses — the record state is the same shape.
         */
        modSwitch.tasks.updateVmServerUuid,

        common.tasks.setupForWaitTask,
        modSwitch.tasks.setSourceDoNotInventory,
        common.tasks.waitTask,

        common.tasks.setupForWaitTask,
        modSwitch.tasks.removeTargetDoNotInventory,
        common.tasks.waitTask,

        /*
         * Restore quotas the begin phase peeled back for zfs recv.
         */
        common.tasks.setupForWaitTask,
        migrationCommon.tasks.restoreSourceZfsQuota,
        common.tasks.waitTask,

        common.tasks.setupForWaitTask,
        migrationCommon.tasks.restoreTargetZfsQuota,
        common.tasks.waitTask,

        migrationCommon.tasks.storeSuccess,

        common.tasks.releaseVMTicket
    ],

    onerror: [
        migrationCommon.tasks.storeFailure,
        /*
         * Unlike cold's onerror, we do NOT call startSourceVm here —
         * if the agent failed part-way, the source is either still
         * running or paused-but-recoverable via migrate-rollback-live.
         * Hard-restarting the source risks split-brain if the agent
         * had already begun the dest cutover.  rollback is the right
         * recovery primitive.
         */
        {
            name: 'on_error.release_vm_ticket',
            modules: {
                sdcClients: 'sdc-clients'
            },
            body: common.releaseVMTicketIgnoringErr
        }
    ],

    oncancel: [
        migrationCommon.tasks.storeFailure,
        {
            name: 'on_cancel.release_vm_ticket',
            modules: {
                sdcClients: 'sdc-clients'
            },
            body: common.releaseVMTicketIgnoringErr
        }
    ]
};
