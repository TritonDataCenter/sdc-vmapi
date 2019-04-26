/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * Used to abort a migration.
 *
 * Preconditions:
 *  - migration state can only be 'paused' or 'failed'
 *  - the target instance must still have DNI set
 */

var abort = require('./vm-migration/abort');
var common = require('./job-common');
var migrationCommon = require('./vm-migration/common');
var modSwitch = require('./vm-migration/switch');

var VERSION = '1.0.0';

var workflow = module.exports = {
    name: 'migrate-abort-' + VERSION,
    version: VERSION,
    timeout: 15 * 60, // 15 minutes

    chain: [
        common.tasks.validateForZoneAction,

        migrationCommon.tasks.validate,

        common.tasks.acquireVMTicket,
        common.tasks.waitOnVMTicket,

        migrationCommon.tasks.storeInitialRecord,

        abort.tasks.ensureTargetVmHasDni,

        modSwitch.tasks.unreserveNetworkIps,
        // Do we know if it was migration that stopped the VM?
        // modSwitch.tasks.startSourceVm,

        // From this point on we cannot allow a retry of any commands.
        migrationCommon.tasks.disallowRetry,

        /* Destroy the target vm. */
        common.tasks.setupForWaitTask,
        abort.tasks.deleteTargetDniVm,
        common.tasks.waitTask,

        /* Destroy any leftover sync snapshots */
        common.tasks.setupForWaitTask,
        modSwitch.tasks.removeSourceSnapshots,
        common.tasks.waitTask,

        /* Set quotas back as they should be. */
        common.tasks.setupForWaitTask,
        migrationCommon.tasks.restoreSourceZfsQuota,
        common.tasks.waitTask,

        /* All done - record final details and store as successful */
        migrationCommon.tasks.storeSuccess,

        common.tasks.releaseVMTicket
    ],

    onerror: [
        // TODO: Mark original vm as the main vm.
        migrationCommon.tasks.storeFailure,
        modSwitch.tasks.unreserveNetworkIps,
        common.tasks.releaseVMTicketIgnoringErr
    ],

    oncancel: [
        // TODO: Mark original vm as the main vm.
        migrationCommon.tasks.storeFailure,
        modSwitch.tasks.unreserveNetworkIps,
        common.tasks.releaseVMTicketIgnoringErr
    ]
};
