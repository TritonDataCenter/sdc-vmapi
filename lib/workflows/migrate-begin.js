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

var restify = require('restify');
var sdcClients = require('sdc-clients');

var common = require('./job-common');
var cleanupSource = require('./vm-migration/cleanup_source');
var cleanupTarget = require('./vm-migration/cleanup_target');
var migrationBegin = require('./vm-migration/begin');
var migrationCommon = require('./vm-migration/common');
var sync = require('./vm-migration/sync');

var VERSION = '1.0.0';


var workflow = module.exports = {
    name: 'migrate-begin-' + VERSION,
    version: VERSION,
    timeout: 1800,

    chain: [
        common.tasks.validateForZoneAction,

        migrationCommon.tasks.validate,

        common.tasks.validateNetworks,

        migrationBegin.tasks.createProvisionPayload,

        common.tasks.acquireAllocationTicket,
        common.tasks.waitOnAllocationTicket,

        migrationBegin.tasks.allocateServer,

        common.tasks.releaseAllocationTicket,

        common.tasks.acquireVMTicket,
        common.tasks.waitOnVMTicket,

        migrationCommon.tasks.storeInitialRecord,

        /* Other vm actions are allowed now. */
        common.tasks.releaseVMTicket,

        migrationBegin.tasks.provisionVm,

        migrationCommon.tasks.storeSuccess
    ],

    onerror: [
        migrationCommon.tasks.storeFailure,
        common.tasks.releaseAllocationTicket,
        common.tasks.releaseVMTicketIgnoringErr
    ],

    oncancel: [
        migrationCommon.tasks.storeFailure,
        common.tasks.releaseAllocationTicket,
        common.tasks.releaseVMTicketIgnoringErr
    ]
};
