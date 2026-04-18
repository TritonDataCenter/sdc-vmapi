/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2026 Edgecast Cloud LLC.
 */

/*
 * migrate-begin-live: bhyve live-migration begin phase.
 *
 * Shares almost all tasks with the cold migrate-begin workflow because
 * the begin phase's job is the same in both cases: validate, allocate a
 * target server, provision the hidden migration-target zone (with
 * do_not_inventory / vm_migration_target / autoboot=false — see
 * createProvisionPayload), capture filesystem details, and store the
 * record.  The only live-specific addition is lookupTargetAdminIp,
 * which stashes the target's admin NIC IP on the record so the
 * subsequent live-sync / live-switch tasks know where the source
 * vmm-migrate-agent should open its peer TCP connection.
 *
 * Note: unlike cold begin, live begin does NOT trigger a full zfs
 * send at this phase — that is driven by the first live-sync.  This
 * matches the vmm-migrate-agent's internal state machine, which
 * expects `migrate-begin` (full send) to happen during a `sync` phase
 * driven by cn-agent's machine-migrate-live.js.  See DESIGN-NOTE below.
 *
 * DESIGN-NOTE (phase mapping):
 *   VMAPI phase      vmm-migrate-agent command
 *   -----------      -------------------------
 *   begin (live)     (no agent call — target-prep only)
 *   sync  (live)     migrate-begin if first sync, else migrate-sync
 *   switch (live)    migrate-switch
 *
 *   This asymmetry keeps VMAPI's phase semantics intact (begin = "set
 *   up the target", sync = "move bytes", switch = "cut over") while
 *   respecting the agent's wire protocol.
 */

var common = require('./job-common');
var migrationBegin = require('./vm-migration/begin');
var migrationCommon = require('./vm-migration/common');
var migrationLive = require('./vm-migration/live');

var VERSION = '1.0.0';

var workflow = module.exports = {
    name: 'migrate-begin-live-' + VERSION,
    version: VERSION,
    timeout: 1200,

    chain: [
        common.tasks.validateForZoneAction,

        migrationCommon.tasks.validate,

        common.tasks.setupForWaitTask,
        migrationBegin.tasks.getSourceFilesystemDetails,
        common.tasks.waitTask,
        migrationBegin.tasks.storeSourceFilesystemDetails,

        migrationBegin.tasks.createProvisionPayload,

        common.tasks.acquireAllocationTicket,
        common.tasks.waitOnAllocationTicket,

        migrationBegin.tasks.allocateServer,

        common.tasks.releaseAllocationTicket,

        common.tasks.acquireVMTicket,
        common.tasks.waitOnVMTicket,

        migrationCommon.tasks.storeInitialRecord,

        migrationCommon.tasks.disallowRetry,

        common.tasks.releaseVMTicket,

        migrationBegin.tasks.provisionVm,

        common.tasks.setupForWaitTask,
        migrationBegin.tasks.setCreateTimestamp,
        common.tasks.waitTask,

        common.tasks.setupForWaitTask,
        migrationBegin.tasks.getTargetFilesystemDetails,
        common.tasks.waitTask,
        migrationBegin.tasks.storeTargetFilesystemDetails,

        common.tasks.setupForWaitTask,
        migrationCommon.tasks.removeTargetZfsQuota,
        common.tasks.waitTask,

        common.tasks.setupForWaitTask,
        migrationCommon.tasks.removeSourceZfsQuota,
        common.tasks.waitTask,

        /* Live-specific: resolve source / target admin IPs (needed for
         * the peer connection and for the viz to reach the source
         * agent's SSE stream) and the guest's primary IP (for the
         * viz's connectivity probe).  All three are persisted on the
         * migration record and exposed via GetMigration. */
        migrationLive.tasks.resolveAgentEndpoints,

        migrationCommon.tasks.storeSuccess,

        migrationBegin.tasks.startSyncWhenAutomatic
    ],

    onerror: [
        migrationCommon.tasks.storeFailure,
        migrationBegin.tasks.cleanupTargetNics,
        common.tasks.releaseAllocationTicket,
        common.tasks.releaseVMTicketIgnoringErr
    ],

    oncancel: [
        migrationCommon.tasks.storeFailure,
        migrationBegin.tasks.cleanupTargetNics,
        common.tasks.releaseAllocationTicket,
        common.tasks.releaseVMTicketIgnoringErr
    ]
};
