/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Used to migrate an instance, run via this workflow job.
 */

var common = require('./job-common');
var migrationCommon = require('./vm-migration/common');
var modSwitch = require('./vm-migration/switch');

var VERSION = '1.0.1';

var workflow = module.exports = {
    name: 'migrate-switch-' + VERSION,
    version: VERSION,
    timeout: 7 * 60 * 60, // 7 hours

    chain: [
        common.tasks.validateForZoneAction,

        migrationCommon.tasks.validate,

        common.tasks.acquireVMTicket,
        common.tasks.waitOnVMTicket,
        migrationCommon.tasks.setRecordStateRunning,
        common.tasks.releaseVMTicket,

        /* Stop the vm */
        modSwitch.tasks.stopSourceVm,
        common.tasks.waitForWorkflowJob,

        /* Run the final sync */
        modSwitch.tasks.startFinalSync,
        common.tasks.waitForSync,

        common.tasks.acquireVMTicket,
        common.tasks.waitOnVMTicket,

        /* Update and then write the 'switch' migration record. */
        modSwitch.tasks.getRecord,
        migrationCommon.tasks.storeInitialRecord,

        modSwitch.tasks.ensureSourceVmStopped,

        /* Switch over instances. */
        modSwitch.tasks.reserveNetworkIps,
        modSwitch.tasks.storeReservedNetworkIps,

        common.tasks.setupForWaitTask,
        modSwitch.tasks.setupTargetFilesystem,
        common.tasks.waitTask,

        common.tasks.setupForWaitTask,
        modSwitch.tasks.disableSourceVmAutoboot,
        common.tasks.waitTask,

        common.tasks.setupForWaitTask,
        modSwitch.tasks.setTargetVmAutoboot,
        common.tasks.waitTask,

        // From this point on we cannot allow a retry of the switch.
        migrationCommon.tasks.disallowRetry,

        common.tasks.setupForWaitTask,
        modSwitch.tasks.setSourceDoNotInventory,
        common.tasks.waitTask,

        // Dev note: brief window here where the vm could appear to have
        // been destroyed (i.e. both have 'do_not_inventory' set).

        modSwitch.tasks.updateVmServerUuid,

        common.tasks.setupForWaitTask,
        modSwitch.tasks.removeTargetDoNotInventory,
        common.tasks.waitTask,

        /* Destroy any leftover sync snapshots */
        modSwitch.tasks.removeSourceSnapshots,
        common.tasks.waitTask,
        modSwitch.tasks.removeTargetSnapshots,
        common.tasks.waitTask,

        common.tasks.setupForWaitTask,
        modSwitch.tasks.restoreIndestructibleZoneroot,
        common.tasks.waitTask,

        common.tasks.setupForWaitTask,
        modSwitch.tasks.restoreIndestructibleDelegated,
        common.tasks.waitTask,

        /* Set quotas back as they should be. */
        common.tasks.setupForWaitTask,
        migrationCommon.tasks.restoreSourceZfsQuota,
        common.tasks.waitTask,

        common.tasks.setupForWaitTask,
        migrationCommon.tasks.restoreTargetZfsQuota,
        common.tasks.waitTask,

        modSwitch.tasks.unreserveNetworkIps,

        /* All done - record final details and store as successful */
        migrationCommon.tasks.storeSuccess,

        common.tasks.releaseVMTicket,

        /* Restart the vm */
        modSwitch.tasks.startTargetVm,
        common.tasks.waitForWorkflowJob
    ],

    onerror: [
        // TODO: Mark original vm as the main vm.
        migrationCommon.tasks.storeFailure,
        modSwitch.tasks.unreserveNetworkIps,
        modSwitch.tasks.startSourceVm,

        {
            name: 'on_error.release_vm_ticket',
            modules: {
                sdcClients: 'sdc-clients'
            },
            body: common.releaseVMTicketIgnoringErr
        }
    ],

    oncancel: [
        // TODO: Mark original vm as the main vm.
        migrationCommon.tasks.storeFailure,
        modSwitch.tasks.unreserveNetworkIps,
        modSwitch.tasks.startSourceVm,
        {
            name: 'on_cancel.release_vm_ticket',
            modules: {
                sdcClients: 'sdc-clients'
            },
            body: common.releaseVMTicketIgnoringErr
        }
    ]
};
