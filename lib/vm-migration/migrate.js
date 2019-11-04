/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * This contains the code to handle vm migrations.
 */

var fs = require('fs');
var util = require('util');

var assert = require('assert-plus');
var restify = require('restify');
var uuid = require('uuid');
var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');

var format = util.format;


var MIGRATION_PROGRESS_FOR_VM_UUID = {};
var MIGRATION_RECORD_FOR_VM_UUID = {};

var VALID_MIGRATION_ACTIONS = [
    'abort',
    'begin',
    'estimate',
    'finalize',
    'pause',
    'rollback',
    'switch',
    'sync'
];


function validateMigrationBegin(vm, ctx, callback) {
    assert.object(vm, 'vm');
    assert.optionalObject(vm.tags, 'vm.tags');
    assert.object(ctx, 'ctx');
    assert.object(ctx.app, 'ctx.app');
    assert.object(ctx.app.options, 'ctx.app.options');
    assert.optionalBool(ctx.app.options.userMigrationAllowed,
        'ctx.app.options.userMigrationAllowed');
    assert.optionalObject(ctx.migrationRecord, 'ctx.migrationRecord');
    assert.object(ctx.req, 'ctx.req');
    assert.func(callback, 'callback');
    assert.optionalUuid(ctx.ownerUuid, 'ctx.ownerUuid');

    var checkUuidProps = ['override_server_uuid', 'override_uuid'];
    var i;
    var p;
    var vmAllowed = false;

    // Validate override params.
    for (i = 0; i < checkUuidProps.length; i++) {
        p = checkUuidProps[i];
        if (ctx.req.params[p] && !common.validUUID(ctx.req.params[p])) {
            callback(new errors.ValidationFailedError(util.format(
                'Invalid parameters: %s (%s) is not a valid UUID',
                p, ctx.req.params[p]), [ errors.invalidUuidErrorsElem(p) ]
            ));
            return;
        }
    }

    if (!ctx.ownerUuid) {
        // This is an operator initiated migration - always allow it.
        vmAllowed = true;
    } else {
        // This is a user initiated migration - check if that is allowed.
        vmAllowed = (ctx.app.options.userMigrationAllowed === true);
        if (vm.internal_metadata.hasOwnProperty('user_migration_allowed')) {
            vmAllowed = (vm.internal_metadata.user_migration_allowed === true);
        }
    }

    if (!vmAllowed) {
        callback(new restify.errors.PreconditionFailedError(
            'User migration on this VM not allowed'));
        return;
    }

    // Check if there is an existing unfinished migration.
    if (ctx.migrationRecord) {
        // Allow a migration that started the begin phase, but did not yet
        // allocate the target instance.
        var disallowRetry = true;
        var history = ctx.migrationRecord.progress_history;
        if (ctx.migrationRecord.phase === 'begin' &&
                ctx.migrationRecord.state === 'failed' &&
                Array.isArray(history) && history.length > 0 &&
                history[history.length-1].phase === 'begin' &&
                !history[history.length-1].disallowRetry) {
            disallowRetry = false;
        }

        if (ctx.migrationRecord.state === 'successful') {
            callback(new restify.errors.PreconditionFailedError(
                'A previous migration exists for this instance, use ' +
                'migration finalize to complete it.'));
            return;
        }

        if (ctx.migrationRecord.state !== 'aborted' && disallowRetry) {
            callback(new restify.errors.PreconditionFailedError(
                'An active migration already exists for this instance'));
            return;
        }

        if (disallowRetry) {
            // This is not a retry, clear the migration record so that we will
            // create a new migration record.
            delete ctx.migrationRecord;
        }
    }

    // Cannot migrate a core Triton instance.
    if (vm.tags && vm.tags.smartdc_type === 'core') {
        callback(new restify.errors.PreconditionFailedError(
            'Cannot migrate a core instance'));
        return;
    }

    // Cannot migrate a Triton nat instance.
    if (vm.tags && vm.tags.smartdc_role === 'nat') {
        callback(new restify.errors.PreconditionFailedError(
            'Cannot migrate a NAT instance'));
        return;
    }

    callback();
}

function migrationEstimate(req, callback) {
    assert.object(req, 'req');
    assert.object(req.vm, 'req.vm');
    assert.object(req.app.cnapi, 'req.app.cnapi');
    assert.object(req.app.cnapi.client, 'req.app.cnapi.client');
    assert.func(callback, 'callback');

    var errMsg = 'Migration estimate failed';
    var headers = {'x-request-id': req.getId()};
    var timeout = 15 * 60 * 1000; // 15 minutes
    var vm = req.vm;

    var payload = {
        action: 'estimate',
        migrationTask: {
            action: 'estimate',
            record: {}
        },
        vm: vm
    };
    var postOpts = {
        headers: headers,
        path: '/servers/' + vm.server_uuid + '/vms/' +
            vm.uuid + '/migrate'
    };

    req.app.cnapi.client.post(postOpts, payload,
            function _estimateCb(err, cnReq, cnRes, body) {
        if (err) {
            callback(err);
            return;
        }

        // Should get back a cnapi task id.
        if (!body || !body.id) {
            callback(new restify.errors.InternalError(
                errMsg + ': invalid cnapi response'));
            return;
        }

        // Wait for the cnapi task to finish.
        req.app.cnapi.waitTask(body.id, {timeout: timeout},
                function (waitErr, waitReq, waitRes, task) {
            if (waitErr) {
                callback(waitErr);
                return;
            }

            if (!task) {
                callback(new restify.errors.InternalError(
                    errMsg + ': no cnapi task'));
                return;
            }

            if (task.status !== 'complete') {
                var errEntries;
                if (Array.isArray(task.history) && task.history.length > 0) {
                    errEntries = task.history.filter(function _histFilt(h) {
                        return h.name === 'error';
                    });
                }
                if (errEntries && errEntries.length > 0) {
                    errMsg += ': ' + errEntries.map(function _errMap(e) {
                        if (e.event && e.event.error) {
                            return e.event.error.message ||
                                String(e.event.error);
                        }
                        return String(e);
                    }).join(', ');
                } else {
                    errMsg += ' (task id ' + body.id + ')';
                }
                callback(new restify.errors.InternalError(errMsg));
                return;
            }

            if (!Array.isArray(task.history) ||
                    task.history.length === 0 ||
                    task.history.slice(-1)[0].name !== 'finish' ||
                    !task.history.slice(-1)[0].event) {
                callback(new restify.errors.InternalError(
                    errMsg + ': no cnapi task finish event'));
                return;
            }

            // TODO: Get the average speed of the last N migrate operations:
            // * average begin time
            // * average sync speed
            // * average switch time
            // and use these to create a more accurate estimation.
            callback(null, task.history.slice(-1)[0].event);
        });
    });
}

function migrationFinalize(req, migrationRecord, callback) {
    assert.object(req, 'req');
    assert.object(req.vm, 'req.vm');
    assert.object(req.app.cnapi, 'req.app.cnapi');
    assert.object(req.app.cnapi.client, 'req.app.cnapi.client');
    assert.object(migrationRecord, 'migrationRecord');
    assert.func(callback, 'callback');

    var errMsg = 'Migration finalize failed';
    var headers = {'x-request-id': req.getId()};
    var timeout = 15 * 60 * 1000; // 15 minutes

    vasync.pipeline({arg: {}, funcs: [
        function cnapiDeleteSourceVmRequest(ctx, cb) {
            var delOpts = {
                headers: headers,
                path: '/servers/' + migrationRecord.source_server_uuid +
                    '/vms/' + migrationRecord.vm_uuid + '?include_dni=true'
            };

            req.app.cnapi.client.del(delOpts,
                    function _cnapiDeleteCb(err, cnReq, cnRes, task) {
                // Allow a 404 "Vm not found" error - that makes our job easier.
                if (err && err.statusCode !== 404) {
                    cb(null, 'OK - target instance does not exist');
                    return;
                }

                ctx.task = task;
                cb();
            });
        },

        function cnapiWaitDeleteTask(ctx, cb) {
            if (!ctx.task || !ctx.task.id) {
                cb();
                return;
            }

            // Wait for the cnapi task to finish.
            req.app.cnapi.waitTask(ctx.task.id, {timeout: timeout},
                    function (waitErr, waitReq, waitRes, task) {
                // Allow a 404 "Vm not found" error - that makes our job easier.
                if (waitErr && waitErr.statusCode !== 404) {
                    cb(waitErr);
                    return;
                }

                if (!task) {
                    cb();
                    return;
                }

                if (task.status !== 'complete') {
                    var errEntries;
                    if (Array.isArray(task.history) && task.history.length) {
                        errEntries = task.history.filter(function _histFilt(h) {
                            return h.name === 'error';
                        });
                    }
                    if (errEntries && errEntries.length) {
                        errMsg += ': ' + errEntries.map(function _errMap(e) {
                            if (e.event && e.event.error) {
                                return e.event.error.message ||
                                    String(e.event.error);
                            }
                            return String(e);
                        }).join(', ');
                    } else {
                        errMsg += ' (task id ' + task.id + ')';
                    }
                    cb(new restify.errors.InternalError(errMsg));
                    return;
                }

                if (!Array.isArray(task.history) ||
                        task.history.length === 0 ||
                        task.history.slice(-1)[0].name !== 'finish' ||
                        !task.history.slice(-1)[0].event) {
                    cb(new restify.errors.InternalError(
                        errMsg + ': no cnapi task finish event'));
                    return;
                }

                cb();
            });
        },

        function removeMigrationRecord(ctx, cb) {
            req.app.moray.delVmMigration(migrationRecord.id, cb);
        }

    ]}, callback);
}

/**
 * For migration, we must convert the existing vm nics into network objects,
 * which is then stored into req.params.networks. The reason for this is that
 * the vms.preFilterNetworks function will then be used to load all network
 * information. This is required later during server allocation (in determining
 * nic tag requirements).
 */
function preloadNetworkParams(req, res, next) {
    if (req.params.action !== 'migrate' ||
            req.params.migration_action !== 'begin' ||
            !req.vm ||
            !req.vm.nics) {
        next();
        return;
    }

    // Convert nics into network params.
    req.params.networks = req.vm.nics.map(function _nicToMac(nic) {
        var netObj = {
            mac: nic.mac,
            uuid: nic.network_uuid
        };
        if (nic.primary) {
            netObj.primary = nic.primary;
        }
        return netObj;
    });

    next();
}

/*
 * Migrates a vm with ?action=migrate
 */
function migrateVm(req, res, next) {
    assert.object(req, 'req');
    assert.object(req.params, 'req.params');
    assert.optionalString(req.params.migration_action,
        'req.params.migration_action');
    assert.object(req.vm, 'req.vm');
    assert.object(res, 'res');
    assert.object(req.filteredNetworks, 'req.filteredNetworks');
    assert.func(next, 'next');

    var actionIsRunning = true;
    var OK_EARLY_ABORT = true;
    var log = req.log;
    var vm = req.vm;

    log.trace({vm_uuid: req.params.uuid, action: req.params.action},
        'MigrateVm handler started');

    var action = req.params.migration_action;
    var automatic = false;
    if (req.params.migration_automatic === 'true' ||
            req.params.migration_automatic === true) {
        automatic = true;
    }

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
                                (action === 'begin' || action === 'estimate')) {
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
            if (req.params.owner_uuid) {
                ctx.ownerUuid = req.params.owner_uuid;
            }

            if (action === 'begin' || action === 'estimate') {
                ctx.app = req.app;
                ctx.req = req;
                validateMigrationBegin(vm, ctx, cb);
                return;
            }

            assert.object(ctx.migrationRecord, 'ctx.migrationRecord');

            log.debug({migrationRecord: ctx.migrationRecord},
                'Current migration record');

            var phase = ctx.migrationRecord.phase;
            var state = ctx.migrationRecord.state;

            switch (action) {
                case 'abort':
                    if (state === 'running' || state === 'successful') {
                        cb(new restify.errors.PreconditionFailedError(
                            'Abort cannot work on a ' + state + ' migration'));
                        return;
                    }
                    break;
                case 'finalize':
                    if (state !== 'successful') {
                        cb(new restify.errors.PreconditionFailedError(
                            'Finalize only works on a successful migration'));
                        return;
                    }
                    break;
                case 'pause':
                    if (phase !== 'sync' || state !== 'running') {
                        cb(new restify.errors.PreconditionFailedError(
                            'Pause requires a running migration sync action'));
                        return;
                    }
                    break;
                case 'rollback':
                    if (state !== 'successful' && phase !== 'rollback') {
                        cb(new restify.errors.PreconditionFailedError(
                            'Rollback only works on a successful migration'));
                        return;
                    }
                    break;
                case 'switch':
                    if (phase !== 'begin' && phase !== 'sync') {
                        cb(new restify.errors.PreconditionFailedError(
                            'Cannot switch in migration phase: ' + phase));
                        return;
                    }
                    if (state !== 'paused' && state !== 'failed') {
                        // Allow migration switch to run from state 'running'
                        // when it is a migration subtask.
                        if (state !== 'running' ||
                                !req.params.is_migration_subtask) {
                            cb(new restify.errors.PreconditionFailedError(
                                'Cannot switch in migration state: ' + state));
                            return;
                        }
                    }
                    // Ensure that at least one successful sync operation has
                    // been run.
                    if (!ctx.migrationRecord.num_sync_phases) {
                        cb(new restify.errors.PreconditionFailedError(
                            'You must perform at least one ' +
                            '"migration sync" operation before switching'));
                        return;
                    }
                    break;
                case 'sync':
                    if (state !== 'paused' && state !== 'failed') {
                        // Allow migration sync to run from state 'running'
                        // when it is a migration subtask.
                        if (state !== 'running' ||
                                !req.params.is_migration_subtask) {
                            cb(new restify.errors.PreconditionFailedError(
                                'Cannot sync in migration state: ' + state));
                            return;
                        }
                    }
                    if (phase === 'begin' && state === 'paused') {
                        cb();
                        return;
                    }
                    if (phase === 'sync' && (state === 'paused' ||
                            state === 'failed')) {
                        cb();
                        return;
                    }
                    if (state === 'running' &&
                            req.params.is_migration_subtask) {
                        cb();
                        return;
                    }

                    cb(new restify.errors.PreconditionFailedError(
                        'Cannot sync when in migration phase: ' + phase));
                    return;
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

            migrationEstimate(req, function _getEstimate(err, result) {
                if (err) {
                    cb(err);
                    return;
                }

                res.send(200, result);
                cb(OK_EARLY_ABORT);
            });
        },

        function do_migration_finalize(ctx, cb) {
            assert.notEqual(action, 'estimate');

            if (action !== 'finalize') {
                cb();
                return;
            }

            migrationFinalize(req, ctx.migrationRecord,
                    function _migrationFinalizeCb(err) {
                if (err) {
                    cb(err);
                    return;
                }

                res.send(200);
                cb(OK_EARLY_ABORT);
            });
        },

        function do_get_image(ctx, cb) {
            assert.notEqual(action, 'estimate');
            assert.notEqual(action, 'finalize');

            if (action !== 'begin') {
                cb();
                return;
            }

            var img_uuid = vm.image_uuid || vm.disks[0].image_uuid;

            req.app.imgapi.getImage(img_uuid, function (err, image) {
                if (err) {
                    cb(err);
                    return;
                }

                // XXX what should we do in the case of an image that is not
                // 'active'?
                vm.image = image;
                cb();
            });
        },

        function do_get_package(ctx, cb) {
            assert.notEqual(action, 'estimate');
            assert.notEqual(action, 'finalize');

            if (action !== 'begin') {
                cb();
                return;
            }

            var errs = [];
            common.validatePackageValues(req.app.papi, vm, errs, function () {
                if (errs.length > 0) {
                    cb(new errors.ValidationFailedError('Invalid VM parameters',
                        errs));
                    return;
                }
                cb();
            });
        },

        function abort_with_no_target_server_uuid(ctx, cb) {
            assert.notEqual(action, 'estimate');
            assert.notEqual(action, 'finalize');

            if (action !== 'abort') {
                cb();
                return;
            }

            assert.object(ctx.migrationRecord, 'ctx.migrationRecord');

            // When there is no target_server_uuid, the target instance was not
            // allocated, which means we simply mark the migration record as
            // aborted and be done.
            var record = ctx.migrationRecord;
            if (record.target_server_uuid) {
                cb();
                return;
            }

            // Add a progress entry.
            var currentTimestamp = new Date().toISOString();
            var progressEntry = {
                type: 'progress',
                phase: 'abort',
                state: 'successful',
                started_timestamp: currentTimestamp,
                finished_timestamp: currentTimestamp,
                current_progress: 100,
                total_progress: 100
            };
            record.progress_history.push(progressEntry);

            // Update record.
            record.finished_timestamp = currentTimestamp;
            record.state = 'aborted';

            req.app.moray.putVmMigration(record,
                    function _abortPutVmMigration(err) {
                if (err) {
                    cb(err);
                    return;
                }

                // Mark that the action is not running (it's already completed).
                actionIsRunning = false;

                res.send(200, {
                    migration: record
                });
                cb(OK_EARLY_ABORT);
            });
        },

        function start_create_new_record(ctx, cb) {
            assert.notEqual(action, 'estimate');
            assert.notEqual(action, 'finalize');

            if (action !== 'begin') {
                cb();
                return;
            }

            // Keep the same record when a migration record already exists. This
            // is here to stop duplicate Moray records in the case where we are
            // retrying the 'begin' phase.
            var record = ctx.migrationRecord;
            if (!record) {
                record = {
                    action: action,
                    automatic: automatic,
                    created_timestamp: (new Date()).toISOString(),
                    id: uuid.v4(),
                    num_sync_phases: 0,
                    owner_uuid: req.params.owner_uuid,
                    phase: 'begin',
                    progress_history: [],
                    source_server_uuid: vm.server_uuid,
                    state: 'running',
                    target_vm_uuid: vm.uuid,
                    vm_uuid: vm.uuid
                };
            }

            // Allow overriding of the target server.
            if (req.params.override_server_uuid) {
                assert.uuid(req.params.override_server_uuid,
                    'req.params.override_server_uuid');
                record.target_server_uuid = req.params.override_server_uuid;
            }

            // The target vm uuid should be the same as the vm uuid, except in
            // the case of testing, where we allow a different uuid to in order
            // to support migration to the same CN (e.g. migration in COAL).
            if (req.params.override_uuid) {
                assert.uuid(req.params.override_uuid,
                    'req.params.override_uuid');

                if (!fs.existsSync('/lib/sdc/.sdc-test-no-production-data')) {
                    cb(new Error('Cannot override vm uuid - no ' +
                        '/lib/sdc/.sdc-test-no-production-data file exists'));
                    return;
                }

                record.target_vm_uuid = req.params.override_uuid;
            }

            ctx.migrationRecord = record;

            req.app.moray.putVmMigration(record, cb);
        },

        function start_migration_workflow(ctx, cb) {
            assert.notEqual(action, 'estimate');
            assert.notEqual(action, 'finalize');

            req.migrationTask = {
                action: action,
                record: ctx.migrationRecord
            };
            req.app.wfapi.createMigrateJob(req, function (jobErr, jobUuid) {
                if (jobErr) {
                    cb(jobErr);
                    return;
                }

                var migrationRecord = translateVmMigration(ctx.migrationRecord);
                // Since the update of the record does not occur until the
                // workflow is up and running (it just started), we have to
                // tweak some parameters of the migration record.
                migrationRecord.phase = action;
                migrationRecord.state = 'running';

                res.header('workflow-api', req.app.wfapi.url);
                res.send(202, {
                    job_uuid: jobUuid,
                    migration: migrationRecord
                });
                cb();
            });
        }
    ]}, function _pipelineCb(err) {
        if (err && err !== OK_EARLY_ABORT) {
            next(err);
            return;
        }

        // Keep a record of the running (or soon to be running) phase.
        if (actionIsRunning && (action === 'begin' || action === 'sync' ||
                action === 'switch' || action === 'abort' ||
                action === 'rollback')) {
            req.migrationTask.record.state = 'running';
            MIGRATION_RECORD_FOR_VM_UUID[vm.uuid] = req.migrationTask.record;
            // Clear old progress events.
            delete MIGRATION_PROGRESS_FOR_VM_UUID[vm.uuid];
        }

        next();
    });
}


function loadVmMigration(req, res, next) {
    assert.object(req, 'req');
    assert.object(req.app, 'req.app');
    assert.object(req.app.moray, 'req.app.moray');
    assert.object(req.log, 'req.log');
    assert.optionalObject(req.vm, 'req.vm');
    assert.func(next, 'next');

    var log = req.log;

    if (!req.vm || !req.vm.uuid || !req.vm.server_uuid) {
        log.error({vm_uuid: req.params.uuid}, 'loadVmMigration:: invalid vm');
        next(new restify.errors.PreconditionFailedError('Invalid vm instance'));
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
    var result = {
        type: 'progress'
    };
    var exposedFields = [
        'current_progress',
        'duration_ms',
        'finished_timestamp',
        'error',
        'message',
        'phase',
        'state',
        'started_timestamp',
        'total_progress',
        'type'
    ];

    for (i = 0; i < exposedFields.length; i++) {
        field = exposedFields[i];
        if (entry.hasOwnProperty(field)) {
            result[field] = entry[field];
        }
    }

    // Add duration_ms field.
    if (!entry.hasOwnProperty('duration_ms')) {
        if (entry.finished_timestamp) {
            result.duration_ms = new Date(entry.finished_timestamp) -
                new Date(entry.started_timestamp);
        } else {
            result.duration_ms = new Date() - new Date(entry.started_timestamp);
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
        'duration_ms',
        'error',
        'finished_timestamp',
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

    if (!migration.hasOwnProperty('duration_ms')) {
        migration.duration_ms = (migration.progress_history || []).reduce(
            function accumulate_total(total, entry) {
                return total + entry.duration_ms;
            }, 0);
    }

    return result;
}


function addDuration(migration) {
    // Get the total duration from all of the actions.
    if (!migration.hasOwnProperty('duration_ms')) {
        migration.duration_ms = (migration.progress_history || []).reduce(
            function accumulate_total(total, entry) {
                if (!entry.hasOwnProperty('duration_ms')) {
                    if (entry.finished_timestamp) {
                        entry.duration_ms = new Date(entry.finished_timestamp) -
                            new Date(entry.started_timestamp);
                    } else {
                        entry.duration_ms = new Date() -
                            new Date(entry.started_timestamp);
                    }
                }
                return total + entry.duration_ms;
            }, 0);
    }

    return migration;
}


function getVmMigration(req, res, next) {
    assert.object(req.vmMigration, 'req.vmMigration');

    if (req.params.format === 'raw') {
        res.send(200, addDuration(req.vmMigration));
    } else {
        res.send(200, translateVmMigration(req.vmMigration));
    }

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

        if (req.params.format === 'raw') {
            res.send(200, migrations.map(addDuration));
        } else {
            res.send(200, migrations.map(translateVmMigration));
        }

        next();
    }
}


function storeMigrationRecord(req, res, next) {
    // TODO: Check etag?
    var record = req.body;

    // For rollback - at the end of a successful rollback we want to delete
    // the migration record.
    if (record.state === 'successful' && record.phase === 'rollback') {
        req.app.moray.delVmMigration(record.id,
                function _delMigrationCb(err, etag) {
            if (err) {
                next(err);
                return;
            }

            MIGRATION_RECORD_FOR_VM_UUID[record.vm_uuid] = record;

            res.send(200);
            next();
        });

        return;
    }

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
    var nextProgressIdx = 0;
    var lastRecord;
    var lastSend = 0;
    var getMigrationErrCount = 0;
    var log = req.log;
    var ONE_MINUTE_SECS = 60;
    var ONE_SECOND_MS = 1000;
    var progressAttemptCounter = 0;
    var socketClosed = false;
    var sourceServerUuid = req.vmMigration.source_server_uuid;
    var vmUuid = req.vmMigration.vm_uuid;
    var watchEnded = false;
    var watchErrorMsg;

    if (!Array.isArray(history)) {
        log.error({migration: req.vmMigration}, 'Invalid migration record');
        next(new restify.errors.PreconditionFailedError(
            'Migration record is invalid'));
        return;
    }

    // Watch for the client to close it's connection.
    req.on('close', function _watchDetectReqClose() {
        watchEnded = true;
        socketClosed = true;
        log.debug('watchVmMigration:: watch request closed');
    });

    // Watch for the response to end.
    res.on('end', function _watchDetectResEnd() {
        watchEnded = true;
        socketClosed = true;
        log.debug('watchVmMigration:: watch response ended');
    });

    // Watch for timeout.
    res.on('timeout', function _watchDetectResTimeout() {
        log.debug('watchVmMigration:: watch response timeout');
    });

    res.writeHead(200, {'Content-Type': 'application/x-json-stream'});

    if (history.length > 0) {
        if (history[history.length - 1].state === 'running') {
            // Write out the last progress_history event.
            res.write(JSON.stringify(translateProgressEntry(
                history[history.length - 1])) + '\n');
        }
        nextProgressIdx = history.length;
    }

    if (req.vmMigration.state !== 'running') {
        // Allow for a just recently started action (i.e. when the workflow has
        // not yet started and has not yet updated the migration record state to
        // running).
        if (!MIGRATION_RECORD_FOR_VM_UUID[vmUuid] ||
                MIGRATION_RECORD_FOR_VM_UUID[vmUuid].state !== 'running') {
            // Send out any pending progress events first.
            if (MIGRATION_PROGRESS_FOR_VM_UUID[vmUuid]) {
                res.write(JSON.stringify(MIGRATION_PROGRESS_FOR_VM_UUID[vmUuid])
                    + '\n');
            }
            // Send the end event.
            res.write(JSON.stringify(
                {
                    type: 'end',
                    phase: req.vmMigration.phase,
                    state: req.vmMigration.state,
                    message: req.vmMigration.error
                }) + '\n');
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

        function attemptDone(progressSent) {
            if (progressSent) {
                progressAttemptCounter = 0;
                setTimeout(callback, ONE_SECOND_MS);
                return;
            }

            // When 10 progress attempts have been made and there has been no
            // progress sent, go and load the record from moray.

            progressAttemptCounter += 1;
            if (progressAttemptCounter < 10) {
                setTimeout(callback, ONE_SECOND_MS);
                return;
            }

            progressAttemptCounter = 0;

            function onGetMigration(err, migration) {
                if (err) {
                    getMigrationErrCount += 1;

                    if (getMigrationErrCount >= 6) {
                        watchEnded = true;
                        watchErrorMsg =
                            'Watch error: unable to load the migration record.';
                    }
                    setTimeout(callback, ONE_SECOND_MS);
                }

                getMigrationErrCount = 0;
                MIGRATION_RECORD_FOR_VM_UUID[vmUuid] = migration;
                setTimeout(callback, ONE_SECOND_MS);
            }

            var lookupParams = {
                source_server_uuid: sourceServerUuid,
                vm_uuid: vmUuid
            };
            req.app.moray.getVmMigrationByParams(lookupParams, onGetMigration);
        }

        if (!event && !record) {
            attemptDone(false);
            return;
        }

        if (!watchEnded && event === lastEvent && record === lastRecord &&
                (process.hrtime()[0] - lastSend) < ONE_MINUTE_SECS) {
            // Nothing has changed or we sent an event less than a minute ago.
            attemptDone(false);
            return;
        }

        lastSend = process.hrtime()[0];

        // Write new progress_history entries.
        if (record && record !== lastRecord) {
            lastRecord = record;

            if (record.progress_history &&
                    record.progress_history.length > nextProgressIdx) {
                for (var idx = nextProgressIdx;
                        idx < record.progress_history.length; idx++) {
                    res.write(JSON.stringify(
                        translateProgressEntry(record.progress_history[idx])) +
                        '\n');
                }
                nextProgressIdx = record.progress_history.length;
            }

            if (record.state !== 'running') {
                log.trace({state: record.state},
                    'migration watch record no longer running');
                watchEnded = true;
                watchErrorMsg = record.state !== 'successful' && record.error;
            }
        }

        // Write progress entry.
        if (event && event !== lastEvent) {
            lastEvent = event;
            res.write(JSON.stringify(event) + '\n');
        }

        // Delay the next progress send (to avoid burning CPU).
        attemptDone(true);
    }

    vasync.whilst(connectedAndRunning, sendProgress,
            function _onWatchWhilstCb(err) {

        var record = MIGRATION_RECORD_FOR_VM_UUID[vmUuid];
        var phase = record && record.phase || req.vmMigration.phase;

        log.debug({err: err, socketClosed: socketClosed},
            'watchVmMigration:: vasync.whilst finished');

        if (socketClosed) {
            return;
        }

        if (err) {
            res.write(JSON.stringify({
                type: 'end',
                phase: phase,
                state: 'failed',
                message: err.message || String(err)
            }) + '\n');
        } else if (watchErrorMsg) {
            res.write(JSON.stringify({
                type: 'end',
                phase: phase,
                state: 'failed',
                message: watchErrorMsg
            }) + '\n');
        } else if (record) {
            res.write(JSON.stringify({
                type: 'end',
                phase: phase,
                state: record.state,
                message: record.error
            }) + '\n');
        } else {
            res.write(JSON.stringify({
                type: 'end',
                phase: phase,
                state: 'unknown'
            }) + '\n');
        }

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
        next(new restify.errors.InternalError('No vm uuid provided'));
        return;
    }

    if (!req.body || !req.body.type || req.body.type !== 'progress') {
        next(new restify.errors.InternalError('No progress event provided'));
        return;
    }

    MIGRATION_PROGRESS_FOR_VM_UUID[req.params.uuid] = req.body;

    res.send(200);
    next();
}


function updateVmServerUuid(req, res, next) {
    assert.object(req, 'req');
    assert.object(req.params, 'req.params');
    assert.uuid(req.params.server_uuid, 'req.params.server_uuid');
    assert.object(req.vm, 'req.vm');
    assert.object(res, 'res');
    assert.func(next, 'next');

    req.vm.server_uuid = req.params.server_uuid;
    next();
}


module.exports = {
    getVmMigration: getVmMigration,
    loadVmMigration: loadVmMigration,
    listVmMigrations: listVmMigrations,
    migrateVm: migrateVm,
    onProgress: onProgress,
    preloadNetworkParams: preloadNetworkParams,
    storeMigrationRecord: storeMigrationRecord,
    updateVmServerUuid: updateVmServerUuid,
    watchVmMigration: watchVmMigration
};
