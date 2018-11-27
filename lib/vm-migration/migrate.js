/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * This contains the code to handle vm migrations.
 */

var util = require('util');

var assert = require('assert-plus');
var libuuid = require('libuuid');
var restify = require('restify');
var vasync = require('vasync');
var common = require('../common');

var errors = require('../errors');

var format = util.format;


var MIGRATION_PROGRESS_FOR_VM_UUID = {};
var MIGRATION_RECORD_FOR_VM_UUID = {};

var VALID_MIGRATION_ACTIONS = [
    'abort',
    'estimate',
    'full',
    'pause',
    'start',
    'switch',
    'sync'
];


function validateMigrationStart(vm, ctx, callback) {
    // Check if there is an existing unfinished migration.
    if (ctx.migrationRecord) {
        if (ctx.migrationRecord.state !== 'finished' &&
                ctx.migrationRecord.state !== 'aborted') {
            callback(new restify.errors.InvalidArgumentError(
                'An active migration already exists for this instance'));
            return;
        }
    }

    // Cannot migrate a core Triton instance.
    if (vm.tags && vm.tags.smartdc_type === 'core') {
        callback(new restify.errors.InvalidArgumentError(
            'Cannot migrate a core instance'));
        return;
    }

    // Cannot migrate a Triton nat instance.
    if (vm.tags && vm.tags.smartdc_role === 'nat') {
        callback(new restify.errors.InvalidArgumentError(
            'Cannot migrate a NAT instance'));
        return;
    }

    callback();
}

/*
 * Migrates a vm with ?action=migrate
 */
function migrateVm(req, res, next) {
    assert.object(req, 'req');
    assert.optionalString(req.params.migration_action,
        'req.params.migration_action');
    assert.object(req.params, 'req.params');
    assert.object(req.vm, 'req.vm');
    assert.object(res, 'res');
    assert.object(req.filteredNetworks, 'req.filteredNetworks');
    assert.func(next, 'next');

    var OK_EARLY_ABORT = true;
    var log = req.log;
    var vm = req.vm;

    log.trace({ vm_uuid: req.params.uuid, action: req.params.action },
        'MigrateVm handler started');

    var action = req.params.migration_action;

    if (!action || VALID_MIGRATION_ACTIONS.indexOf(action) === -1) {
        next(new restify.errors.InvalidArgumentError(
            'Invalid migration action'));
        return;
    }

    vasync.pipeline({arg: {}, funcs: [
        function load_migration_record(ctx, cb) {
            var lookupParams = {
                source_server_uuid: vm.server_uuid,
                vm_uuid: vm.uuid
            };
            req.app.moray.getVmMigrationByParams(lookupParams,
                function _loadMigration(err, record) {
                    if (err) {
                        if (err.statusCode === 404 &&
                                (action === 'start' || action === 'full' ||
                                action === 'estimate')) {
                            // Not found error - which is only allowed when
                            // starting a new migration.
                            cb();
                            return;
                        }
                        cb(err);
                        return;
                    }
                    ctx.migrationRecord = record;
                    log.debug({
                            uuid: vm.vm_uuid,
                            phase: record.phase,
                            state: record.state
                        },
                        'Found existing migration record');
                    cb();
                });
        },

        function validate(ctx, cb) {
            if (action === 'start' || action === 'full' ||
                    action === 'estimate') {
                validateMigrationStart(vm, ctx, cb);
                return;
            }

            assert.object(ctx.migrationRecord, 'ctx.migrationRecord');

            log.debug({migrationRecord: ctx.migrationRecord},
                'Current migration record');

            var phase = ctx.migrationRecord.phase;
            var state = ctx.migrationRecord.state;

            switch (action) {
                case 'abort':
                    if (state !== 'running') {
                        cb(new restify.errors.InvalidArgumentError(
                            'Abort requires a running migration'));
                        return;
                    }
                    break;
                case 'pause':
                    if (phase !== 'sync' || state !== 'running') {
                        cb(new restify.errors.InvalidArgumentError(
                            'Pause requires a running migration sync action'));
                        return;
                    }
                    break;
                case 'switch':
                    if (phase !== 'start' && phase !== 'sync') {
                        cb(new restify.errors.InvalidArgumentError(
                            'Cannot switch in migration phase: ' + phase));
                        return;
                    }
                    if (state !== 'paused' && state !== 'failed') {
                        cb(new restify.errors.InvalidArgumentError(
                            'Cannot switch in migration state: ' + state));
                        return;
                    }
                    break;
                case 'sync':
                    if (state !== 'paused' && state !== 'failed') {
                        cb(new restify.errors.InvalidArgumentError(
                            'Cannot sync in migration state: ' + state));
                        return;
                    }
                    if (phase !== 'start' && phase !== 'sync') {
                        cb(new restify.errors.InvalidArgumentError(
                            'Cannot sync when in migration phase: ' + phase));
                        return;
                    }
                    break;
                default:
                    assert.fail(format('Unvalidated vm migration action: %s',
                        action));
                    break;
            }

            cb();
        },

        function do_migration_estimate(ctx, cb) {
            if (action !== 'estimate') {
                cb();
                return;
            }

            req.migrationTask = {
                action: action,
                record: ctx.migrationRecord
            };
            req.app.wfapi.createMigrateEstimateJob(req,
                    function _onCreateMigrateEstJobCb(jobErr, jobUuid) {
                if (jobErr) {
                    cb(jobErr);
                    return;
                }

                res.header('workflow-api', req.app.wfapi.url);
                res.send(202, { job_uuid: jobUuid });

                // Wait for job?
                cb(OK_EARLY_ABORT);
            });
        },

        function do_get_networks(ctx, cb) {
            // Convert nics into network macs.
            if (vm.nics) {
                vm.networks = vm.nics.map(function _nicToMac(nic) {
                    var netObj = {
                        mac: nic.mac,
                        uuid: nic.network_uuid
                    };
                    if (nic.primary) {
                        netObj.primary = nic.primary;
                    }
                    return netObj;
                });
            }
            cb();
        },

        function do_get_image(ctx, cb) {
            var img_uuid = vm.image_uuid || vm.disks[0].image_uuid;

            req.app.imgapi.getImage(img_uuid, function (err, image) {
                if (err) {
                    cb(err);
                    return;
                }

                // XXX what should we do in the case of an image that is not
                // 'active'?
                vm.image = image;
                return cb();
            });
        },

        function do_get_package(ctx, cb) {
            var errs = [];
            common.validatePackageValues(req.app.papi, vm, errs, function () {
                if (errs) {
                    cb(errs[0]);
                    return;
                }
                cb();
            });
        },

        function start_create_new_record(ctx, cb) {
            assert.notEqual(action, 'estimate');

            if (action !== 'start') {
                cb();
                return;
            }

            var record = {
                action: action,
                automatic: (action === 'full'),
                created_timestamp: (new Date()).toISOString(),
                id: libuuid.create(),
                override_uuid: req.params.override_uuid,
                override_alias: req.params.override_alias,
                num_sync_phases: 0,
                phase: 'start',
                progress_history: [],
                source_server_uuid: vm.server_uuid,
                state: 'running',
                vm_uuid: vm.uuid
            };
            ctx.migrationRecord = record;

            req.app.moray.putVmMigration(record, cb);
        },

        function start_migration_workflow(ctx, cb) {
            assert.notEqual(action, 'estimate');

            req.migrationTask = {
                action: action,
                record: ctx.migrationRecord
            };
            req.app.wfapi.createMigrateJob(req, function (jobErr, jobUuid) {
                if (jobErr) {
                    cb(jobErr);
                    return;
                }

                res.header('workflow-api', req.app.wfapi.url);
                res.send(202, { job_uuid: jobUuid });
                cb();
            });
        }
    ]}, function _pipelineCb(err) {
        if (err && err !== OK_EARLY_ABORT) {
            next(err);
            return;
        }

        // Keep a record of the running (or soon to be running) phase.
        if (action === 'start' || action === 'sync' || action === 'switch') {
            req.migrationTask.record.status = 'running';
            MIGRATION_RECORD_FOR_VM_UUID[vm.uuid] = req.migrationTask.record;
        }

        next();
    });
}


function loadVmMigration(req, res, next) {
    var log = req.log;

    if (!req.vm.uuid || !req.vm.server_uuid) {
        log.error({vm_uuid: req.vm.uuid, server_uuid: req.vm.server_uuid},
            'loadVmMigration:: invalid vm');
        next(new errors.ValidationFailedError('Invalid vm instance'));
        return;
    }

    var lookupParams = {
        source_server_uuid: req.vm.server_uuid,
        vm_uuid: req.vm.uuid
    };
    req.app.moray.getVmMigrationByParams(lookupParams, onLoadMigration);

    function onLoadMigration(err, migration) {
        if (err) {
            next(err);
            return;
        }

        req.vmMigration = migration;

        log.trace({
            id: migration.id,
            phase: migration.phase,
            state: migration.state,
            vm_uuid: migration.vm_uuid
        },
        'Found migration record');

        next();
    }
}


function translateProgressEntry(entry) {
    var field;
    var i;
    var result = {};
    var exposedFields = [
        'current_progress',
        'finished_timestamp',
        'error',
        'message',
        'phase',
        'state',
        'started_timestamp',
        'total_progress'
    ];

    for (i = 0; i < exposedFields.length; i++) {
        field = exposedFields[i];
        if (entry.hasOwnProperty(field)) {
            result[field] = entry[field];
        }
    }

    return result;
}

function translateVmMigration(migration) {
    var field;
    var i;
    var result = {};
    var exposedFields = [
        'automatic',
        'created_timestamp',
        'error',
        'finished_timestamp',
        // 'id',
        'phase',
        'started_timestamp',
        'state',
        'vm_uuid'
    ];

    for (i = 0; i < exposedFields.length; i++) {
        field = exposedFields[i];
        if (migration.hasOwnProperty(field)) {
            result[field] = migration[field];
        }
    }

    if (Array.isArray(migration.progress_history)) {
        result.progress_history = migration.progress_history.map(
            translateProgressEntry);
    }

    return result;
}


function getVmMigration(req, res, next) {
    assert.object(req.vmMigration, 'req.vmMigration');

    res.send(200, translateVmMigration(req.vmMigration));
    next();
}


function listVmMigrations(req, res, next) {
    var log = req.log;

    req.app.moray.getVmMigrations(req.params, onLoadMigrations);

    function onLoadMigrations(err, migrations) {
        if (err) {
            next(err);
            return;
        }

        log.trace('Found %d migration records', migrations.length);

        res.send(200, migrations.map(translateVmMigration));

        next();
    }
}


function storeMigrationRecord(req, res, next) {
    // TODO: Check etag?
    var record = req.body;

    req.app.moray.putVmMigration(record, function _putMigrationCb(err, etag) {
        if (err) {
            next(err);
            return;
        }

        MIGRATION_RECORD_FOR_VM_UUID[record.vm_uuid] = record;

        res.send(200);
        next();
    });
}


function watchVmMigration(req, res, next) {
    assert.object(req, 'req');
    assert.object(req.log, 'req.log');
    assert.object(req.vmMigration, 'req.vmMigration');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var history = req.vmMigration.progress_history;
    var lastEvent;
    var lastProgressIdx;
    var lastRecord;
    var lastSend = 0;
    var log = req.log;
    var ONE_MINUTE_SECS = 60;
    var ONE_SECOND_MS = 1000;
    var vmUuid = req.vmMigration.vm_uuid;
    var watchEnded = false;

    if (!Array.isArray(history)) {
        log.error({migration: req.vmMigration}, 'Invalid migration record');
        next(new errors.ValidationFailedError('Migration record is invalid'));
        return;
    }

    // Watch for the client to close it's connection.
    req.on('close', function _watchDetectReqClose() {
        watchEnded = true;
        log.debug('watchVmMigration:: watch request closed');
    });

    // Watch for the response to end.
    res.on('end', function _watchDetectResEnd() {
        watchEnded = true;
        log.debug('watchVmMigration:: watch response ended');
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });

    for (var i = 0; i < history.length; i++) {
        res.write(JSON.stringify(translateProgressEntry(history[i])) + '\n');
    }
    lastProgressIdx = history.length - 1;

    if (req.vmMigration.state !== 'running') {
        // Allow for a just recently started action (i.e. when the workflow has
        // not yet started and has not yet updated the migration record state to
        // running).
        if (!MIGRATION_RECORD_FOR_VM_UUID[vmUuid] ||
                MIGRATION_RECORD_FOR_VM_UUID[vmUuid].status !== 'running') {
            res.write(JSON.stringify({state: 'end'}) + '\n');
            res.end();
            next();
            return;
        }
    }


    function connectedAndRunning() {
        return !watchEnded;
    }

    function sendProgress(callback) {
        var event = MIGRATION_PROGRESS_FOR_VM_UUID[vmUuid];
        var record = MIGRATION_RECORD_FOR_VM_UUID[vmUuid];

        if (!event && !record) {
            setTimeout(callback, ONE_SECOND_MS);
            return;
        }

        if (!watchEnded && event === lastEvent && record === lastRecord &&
                (process.hrtime()[0] - lastSend) < ONE_MINUTE_SECS) {
            // Nothing has changed or we sent an event less than a minute ago.
            setTimeout(callback, ONE_SECOND_MS);
            return;
        }

        lastSend = process.hrtime()[0];

        // Write new history entries.
        if (record && record !== lastRecord) {
            lastRecord = record;

            if (record.progress_history &&
                    record.progress_history.length > lastProgressIdx) {
                for (var idx = lastProgressIdx + 1;
                        idx < record.progress_history.length; idx++) {
                    res.write(JSON.stringify(
                        translateProgressEntry(record.progress_history[idx])) +
                        '\n');
                }
                lastProgressIdx = record.progress_history.length - 1;
            }

            if (record.state !== 'running') {
                watchEnded = true;
            }
        }

        // Write progress entry.
        if (event && event !== lastEvent) {
            lastEvent = event;
            res.write(JSON.stringify(event) + '\n');
        }

        // Delay the next progress send (to avoid burning CPU).
        setTimeout(callback, ONE_SECOND_MS);
    }

    vasync.whilst(connectedAndRunning, sendProgress,
            function _onWatchWhilstCb(err) {
        log.debug({err: err}, 'watchVmMigration:: vasync.whilst finished');
        if (err) {
            res.write(JSON.stringify({
                state: 'failed',
                message: err.message || String(err)
            }) + '\n');
        }
        res.write(JSON.stringify({state: 'end'}) + '\n');

        res.end();
    });

    next();
}


function onProgress(req, res, next) {
    assert.object(req, 'req');
    assert.object(req.log, 'req.log');
    assert.object(res, 'res');
    assert.func(next, 'next');

    if (!req.params.uuid) {
        next(new errors.ValidationFailedError('No vm uuid provided'));
        return;
    }

    if (!req.body || !req.body.type || req.body.type !== 'progress') {
        next(new errors.ValidationFailedError('No progress event provided'));
        return;
    }

    // var previousEntry = MIGRATION_PROGRESS_FOR_VM_UUID[req.params.uuid];
    // var entry = {
    //     secs: process.hrtime()[0],
    //     event: req.body
    // };
    // MIGRATION_PROGRESS_FOR_VM_UUID[req.params.uuid] = req.body;
    MIGRATION_PROGRESS_FOR_VM_UUID[req.params.uuid] = req.body;

    res.send(200);
    next();
}


module.exports = {
    getVmMigration: getVmMigration,
    loadVmMigration: loadVmMigration,
    listVmMigrations: listVmMigrations,
    migrateVm: migrateVm,
    onProgress: onProgress,
    storeMigrationRecord: storeMigrationRecord,
    watchVmMigration: watchVmMigration
};
