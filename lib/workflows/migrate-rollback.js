/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Used to rollback a successful migration.
 *
 * Preconditions:
 *  - migration state can only be 'successful'
 *  - the target instance must still exist
 *  - the source instance must still exist and have DNI set
 */

var common = require('./job-common');
var migrationCommon = require('./vm-migration/common');
var modSwitch = require('./vm-migration/switch');
var rollback = require('./vm-migration/rollback');

var VERSION = '1.0.0';

var workflow = module.exports = {
    name: 'migrate-rollback-' + VERSION,
    version: VERSION,
    timeout: 15 * 60, // 15 minutes

    chain: [
        common.tasks.validateForZoneAction,
        migrationCommon.tasks.validate,

        rollback.tasks.ensureSourceVmHasDni,

        /* Stop the target vm */
        rollback.tasks.stopTargetVm,
        common.tasks.waitForWorkflowJob,

        common.tasks.acquireVMTicket,
        common.tasks.waitOnVMTicket,

        rollback.tasks.ensureTargetVmStopped,

        migrationCommon.tasks.storeInitialRecord,

        modSwitch.tasks.reserveNetworkIps,
        modSwitch.tasks.storeReservedNetworkIps,

        common.tasks.setupForWaitTask,
        rollback.tasks.disableTargetVmAutoboot,
        common.tasks.waitTask,

        common.tasks.setupForWaitTask,
        rollback.tasks.setTargetDoNotInventory,
        common.tasks.waitTask,

        // Dev note: brief window here where the vm could appear to have
        // been destroyed (i.e. both have 'do_not_inventory' set).

        modSwitch.tasks.updateVmServerUuid,

        common.tasks.setupForWaitTask,
        migrationCommon.tasks.setSourceVmAutoboot,
        common.tasks.waitTask,

        common.tasks.setupForWaitTask,
        rollback.tasks.removeSourceDoNotInventory,
        common.tasks.waitTask,

        common.tasks.setupForWaitTask,
        rollback.tasks.removeTargetIndestructibleZoneroot,
        common.tasks.waitTask,

        common.tasks.setupForWaitTask,
        rollback.tasks.removeTargetIndestructibleDelegated,
        common.tasks.waitTask,

        modSwitch.tasks.unreserveNetworkIps,

        /* Destroy the target vm. */
        common.tasks.setupForWaitTask,
        rollback.tasks.deleteTargetDniVm,
        common.tasks.waitTask,

        /* All done - record final details and store as successful */
        migrationCommon.tasks.storeSuccess,

        common.tasks.releaseVMTicket,

        /* Restart the source vm. */
        modSwitch.tasks.startSourceVm,
        common.tasks.waitForWorkflowJob
    ],

    onerror: [
        // TODO: Mark target vm as the main vm.
        migrationCommon.tasks.storeFailure,
        modSwitch.tasks.unreserveNetworkIps,
        common.tasks.releaseVMTicketIgnoringErr
    ],

    oncancel: [
        // TODO: Mark target vm as the main vm.
        migrationCommon.tasks.storeFailure,
        modSwitch.tasks.unreserveNetworkIps,
        common.tasks.releaseVMTicketIgnoringErr
    ]
};
