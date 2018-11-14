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
var restify = require('restify');
var vasync = require('vasync');

var errors = require('../errors');

var format = util.format;


var VALID_MIGRATION_ACTIONS = [
    'abort',
    'estimate',
    'full',
    'notifyProgress',
    'pause',
    'start',
    'storeMigrationRecord',
    'switch',
    'sync',
    'watch'
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
    assert.func(next, 'next');

    var OK_EARLY_ABORT = true;
    var log = req.log;
    var vm = req.vm;

    log.trace({ vm_uuid: req.params.uuid, action: req.params.action },
        'MigrateVm handler started');

    // if (['joyent', 'joyent-minimal', 'lx'].indexOf(vm.brand) === -1) {
    //     return next(new errors.BrandNotSupportedError(
    //         'VM \'brand\' does not support migration'));
    // }

    var action = req.params.migration_action;

    if (!action || VALID_MIGRATION_ACTIONS.indexOf(action) === -1) {
        next(new restify.errors.InvalidArgumentError(
            'Invalid migration action'));
        return;
    }

    vasync.pipeline({arg: {}, funcs: [
        function migration_notify_progress(ctx, cb) {
            if (action !== 'notifyProgress') {
                cb();
                return;
            }

            // TODO: Send progress events to any watchers.

            res.send(204);
            cb(OK_EARLY_ABORT);
        },

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
                                action === 'estimate' ||
                                action === 'storeMigrationRecord')) {
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

        function migration_store_record(ctx, cb) {
            if (action !== 'storeMigrationRecord') {
                cb();
                return;
            }

            // TODO: Check etag?
            req.app.moray.putVmMigration(req.params.migrationRecord,
                    function _putMigrationCb(err, etag) {
                if (err) {
                    cb(err);
                    return;
                }

                res.send(200, req.params.migrationRecord);

                cb(OK_EARLY_ABORT);
            });
        },

        function migration_watch(ctx, cb) {
            if (action !== 'watch') {
                cb();
                return;
            }

            // TODO: Perform watch.
            cb(new errors.ValidationFailedError('Watch is not implemented'));
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

        function start_migration_workflow(ctx, cb) {
            if (action === 'estimate') {
                cb();
                return;
            }

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


function watchVmMigration(req, res, next) {
    // Implement me.
    res.send(200, {});
    next();
}


module.exports = {
    getVmMigration: getVmMigration,
    loadVmMigration: loadVmMigration,
    listVmMigrations: listVmMigrations,
    migrateVm: migrateVm,
    watchVmMigration: watchVmMigration
};
