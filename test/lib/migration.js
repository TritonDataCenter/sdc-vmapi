/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

var stream = require('stream');
var util = require('util');

var assert = require('assert-plus');
var byline = require('byline');
var jsprim = require('jsprim');
var libuuid = require('libuuid');
var restify = require('restify');
var vasync = require('vasync');

var common = require('../common');

var format = util.format;
var waitForValue = common.waitForValue;
var waitForJob = common.waitForJob;


/* Helper functions */

function getJobError(job) {
    if (job && job.chain_results && job.chain_results.length > 0) {
        // Get the error from the last task in the job.
        return JSON.stringify(job.chain_results.slice(-1)[0].error);
    }
    return null;
}

function MigrationWatcher(client, vm_uuid) {
    this.client = client;
    this.vm_uuid = vm_uuid;
    this.ended = false;
    this.events = [];
    this.error = null;

    var options = {};
    stream.Transform.call(this, options);
}
util.inherits(MigrationWatcher, stream.Transform);

MigrationWatcher.prototype._transform =
function _migWatchTransform(chunk, encoding, callback) {
    try {
        this.events.push(JSON.parse(chunk));
    } catch (ex) {
        console.log('# WARNING: Unable to parse watch event: ', String(chunk));
        if (!this.error) {
            this.error = new Error('Unable to parse event:', String(chunk));
        }
    }
    callback();
};

MigrationWatcher.prototype.start = function _migWatchStart() {
    var self = this;
    var requestPath = format('/migrations/%s/watch', self.vm_uuid);

    self.ended = false;

    var httpVmapi = restify.createHttpClient({url: self.client.url.href});

    httpVmapi.get(requestPath, function onMigrateWatchPost(postErr, req) {
        if (postErr) {
            console.log('# ERROR: ', postErr);
            self.ended = true;
            self.error = postErr;
            return;
        }

        req.on('result', function onMigrateWatchResult(err, res) {
            if (err) {
                console.log('# ERROR: ', err);
                self.ended = true;
                self.error = err;
                return;
            }

            res.on('end', function _watcherResEnd() {
                self.ended = true;
            });

            var lineStream = new byline.LineStream();
            res.pipe(lineStream).pipe(self);
        });

        req.end();
    });
};


/* Tests */

function TestMigrationCfg(test, cfg) {
    var client;
    var migrationRolledBack = false;
    var migrationStarted = false;
    var migrationSynced = false;
    var migrationSwitched = false;
    var migrationUuidOverride = false;
    var sourceVm;
    var targetVm;
    var watcher;

    // Helpers
    function createMigrationWatcher(vm_uuid) {
        watcher = new MigrationWatcher(client, vm_uuid);
        watcher.start();
    }
    function destroyMigrationWatcher() {
        watcher = null;
    }

    test.setUp = function (callback) {
        if (client) {
            callback();
            return;
        }
        common.setUp(function (err, _client) {
            assert.ifError(err);
            assert.ok(_client, 'restify client');
            client = _client;
            callback();
        });
    };

    // Count available servers, to see if we need to set override_uuid.
    test.count_running_servers = function test_count_running_servers(t) {
        client.cnapi.get({path: '/servers?setup=true&extras=sysinfo'},
                function _onGetServersCb(err, req, res, servers) {
            common.ifError(t, err, 'get cnapi setup servers');

            if (servers) {
                // Filter running servers and virtual servers.
                var availableServers = servers.filter(function _checkStatus(s) {
                    return s.status === 'running' &&
                        s.sysinfo && s.sysinfo['System Type'] !== 'Virtual';
                });
                t.ok(availableServers.length > 0,
                    'number of available servers: ' + availableServers.length);
                if (availableServers.length < 2) {
                    migrationUuidOverride = true;
                }
            }

            t.done();
        });
    };

    test.create_vm = function (t) {
        var vmUuid;

        vasync.pipeline({arg: {}, funcs: [

            function createVm(ctx, next) {
                client.post({
                    path: '/vms'
                }, cfg.vm, function onVmCreated(err, req, res, body) {
                    var expectedResStatusCode = 202;

                    common.ifError(t, err, 'VM creation should not error');
                    t.equal(res.statusCode, expectedResStatusCode,
                        'HTTP status code should be ' +
                            expectedResStatusCode);

                    if (err) {
                        next(err);
                        return;
                    }

                    if (!body || !body.vm_uuid || !body.job_uuid) {
                        next(new Error('No body vm_uuid or job_uuid returned'));
                        return;
                    }

                    ctx.jobUuid = body.job_uuid;
                    vmUuid = body.vm_uuid;

                    t.ok(body.vm_uuid, 'got a vm uuid: ' + body.vm_uuid);

                    next();
                });
            },

            function waitForProvisioningJob(ctx, next) {
                waitForValue('/jobs/' + ctx.jobUuid, 'execution', 'succeeded',
                    { client: client, timeout: 10 * 60 },
                    function onVmProvisioned(err) {
                        common.ifError(t, err,
                            'VM should provision successfully');
                        next();
                    });
            },
            function getVmServer(ctx, next) {
                client.get('/vms/' + vmUuid, function (err, req, res, body) {
                    common.ifError(t, err, 'VM should appear in vmapi');
                    sourceVm = body;
                    next();
                });
            }
        ]}, function _provisionPipelineCb(err) {
            common.ifError(t, err, 'no provision pipeline err');
            t.done();
        });
    };


    test.bad_migrate_no_action = function (t) {
        // No action.
        client.post({
            path: format('/vms/%s?action=migrate', sourceVm.uuid)
        }, function onMigrateNoAction(err) {
            t.ok(err, 'expect an error when no migration action supplied');
            if (err) {
                t.equal(err.statusCode, 409,
                    format('err.statusCode === 409, got %s', err.statusCode));
            }
            t.done();
        });
    };

    test.user_check_allow_migration_flag_unset = function (t) {
        client.get('/vms/' + sourceVm.uuid,
            function onListVms(err, req, res, vm) {
                t.ifError(err);
                t.ok(vm, 'getting vm should result in a non-empty response');

                t.equal(vm.internal_metadata.user_migration_allowed, undefined);

                t.done();
            });
    };

    test.bad_user_migrate_not_allowed_by_vm_default = function (t) {
        // Check if the vmapi config allows migrations by default, if is is
        // enabled then we can skip this test.
        if (common.config.user_migration_allowed === true) {
            t.ok(true, 'Skip - user migrations are enabled globally');
            t.done();
            return;
        }
        // Should not be able to migrate a zone with
        // user_migration_allowed unset
        client.post({
            path: format('/vms/%s?action=migrate&migration_action=begin'
                + '&owner_uuid=' + cfg.vm.owner_uuid,
                sourceVm.uuid)
        }, function onMigrateVm(err) {
            t.ok(err,
                'expect error attempting migration of a zone ' +
                '(server user_migration_allowed flag not set)');
            if (err) {
                t.equal(err.statusCode, 412,
                    format('err.statusCode === 412, got %s',
                        err.statusCode));
            }
            t.done();
        });
    };

    test.user_set_vm_explicitly_disallow_migrations = function (t) {
        var payload = {};

        client.get('/vms/' + sourceVm.uuid, function (getErr, req, res, body) {
            common.ifError(t, getErr, 'VM should appear in vmapi');

            payload.internal_metadata = body.internal_metadata;
            payload.internal_metadata.user_migration_allowed = false;

            updateVmAndWait(t, client, sourceVm.uuid, payload,
                function onUpdateVm(updateErr) {
                    t.ifError(updateErr);
                    t.done();
                });
        });

    };

    test.user_check_allow_migration_flag_false = function (t) {
        client.get('/vms/' + sourceVm.uuid,
            function onListVms(err, req, res, vm) {
                t.ifError(err);
                t.ok(vm, 'getting vm should result in a non-empty response');

                t.equal(vm.internal_metadata.user_migration_allowed, false);

                t.done();
            });
    };

    test.bad_user_migrate_explicitly_not_allowed_by_vm = function (t) {
        // Should not be able to migrate a zone with
        // user_migration_allowed = false
        client.post({
            path: format('/vms/%s?action=migrate&migration_action=begin'
                + '&owner_uuid=%s', sourceVm.uuid, cfg.vm.owner_uuid)
        }, function onMigrateVm(err) {
            t.ok(err,
                'expect error attempting migration of a zone ' +
                '(server user_migration_allowed flag false)');
            if (err) {
                t.equal(err.statusCode, 412,
                    format('err.statusCode === 412, got %s',
                        err.statusCode));
            }
            t.done();
        });
    };


    test.bad_migrate_unknown_action = function (t) {
        // Unknown migration action.
        client.post({
            path: format('/vms/%s?action=migrate&migration_action=unknown',
                sourceVm.uuid)
        }, function onMigrateNoAction(err) {
            t.ok(err, 'expect an error for an unknown migration action');
            if (err) {
                t.equal(err.statusCode, 409,
                    format('err.statusCode === 409, got %s', err.statusCode));
            }
            t.done();
        });
    };

    [
        'abort',
        'pause',
        'switch',
        'sync'
    ].forEach(function _testNoMigrateForEach(action) {
        test['bad_migrate_' + action + '_when_no_migration'] = function (t) {
            // Try to run a migration action when no migration has been started.
            client.post({
                path: format('/vms/%s?action=migrate&migration_action=%s',
                    sourceVm.uuid, action)
            }, function onMigrateNoMigrationDataCb(err) {
                t.ok(err, 'expect an error when there is no migration entry');
                if (err) {
                    t.equal(err.statusCode, 404,
                        format('err.statusCode === 404, got %s',
                            err.statusCode));
                }
                t.done();
            });
        };
    });

    test.bad_migrate_core_zone = function (t) {
        // Should not be able to migrate a triton core zone.
        vasync.pipeline({arg: {}, funcs: [
            function findCoreZone(ctx, next) {
                client.get({
                    path: '/vms?tag.smartdc_type=core&state=active&limit=1'
                }, function onFindCoreZone(err, req, res, body) {
                    if (err) {
                        t.ok(false, 'unable to query vmapi for core zone: ' +
                            err);
                        next(true);
                        return;
                    }
                    if (!body || !body[0] || !body[0].uuid) {
                        t.ok(false, 'no core zone found');
                        next(true);
                        return;
                    }
                    ctx.vm = body[0];
                    next();
                });
            },

            function migrateCoreZone(ctx, next) {
                client.post({
                    path: format(
                        '/vms/%s?action=migrate&migration_action=begin',
                        ctx.vm.uuid)
                }, function onMigrateCoreZoneCb(err) {
                    t.ok(err, 'expect an error for migration of a core zone');
                    if (err) {
                        t.equal(err.statusCode, 412,
                            format('err.statusCode === 412, got %s',
                                err.statusCode));
                    }
                    next();
                });
            }
        ]}, function _pipelineCb() {
            t.done();
        });
    };

    test.bad_migrate_nat_zone = function (t) {
        // Should not be able to migrate a triton NAT zone.
        vasync.pipeline({arg: {}, funcs: [
            function findNatZone(ctx, next) {
                client.get({
                    path: '/vms?tag.smartdc_role=nat&state=active&limit=1'
                }, function onFindNatZone(err, req, res, body) {
                    if (err) {
                        t.ok(false, 'unable to query vmapi for nat zone: ' +
                            err);
                        next(true);
                        return;
                    }
                    if (!body || !body[0] || !body[0].uuid) {
                        t.ok(true, 'SKIP - no nat zone found');
                        next(true);
                        return;
                    }
                    ctx.vm = body[0];
                    next();
                });
            },

            function migrateNatZone(ctx, next) {
                client.post({
                    path: format(
                        '/vms/%s?action=migrate&migration_action=begin',
                        ctx.vm.uuid)
                }, function onMigrateNatZoneCb(err) {
                    t.ok(err, 'expect an error for migration of a nat zone');
                    if (err) {
                        t.equal(err.statusCode, 412,
                            format('err.statusCode === 412, got %s',
                                err.statusCode));
                    }
                    next();
                });
            }
        ]}, function _pipelineCb() {
            t.done();
        });
    };

    test.migration_estimate = function test_migration_estimate(t) {
        if (!sourceVm) {
            t.ok(false, 'Original VM was not created successfully');
            t.done();
            return;
        }

        client.post(
            {path: format('/vms/%s?action=migrate&migration_action=estimate',
                    sourceVm.uuid)},
            onMigrateEstimateCb);

        function onMigrateEstimateCb(err, req, res, body) {
            common.ifError(t, err, 'no error when estimating the migration');
            if (err) {
                t.done();
                return;
            }

            t.ok(res, 'estimate: got a restify response object');
            if (res) {
                t.equal(res.statusCode, 200,
                    format('err.statusCode === 200, got %s', res.statusCode));
                t.ok(res.body, 'estimate: got a restify response body object');
            }

            t.ok(body, 'estimate: got a response body');
            if (!body) {
                t.done();
                return;
            }

            t.ok(body.size, 'estimate: got body.size estimate');
            t.ok(body.size > 0, 'estimate: got body.size >= 0: ' + body.size);
            t.done();
        }
    };

    test.migration_begin_for_abort = function test_migration_begin_abort(t) {
        if (!sourceVm) {
            t.ok(false, 'Original VM was not created successfully');
            t.done();
            return;
        }

        var params = {};

        if (migrationUuidOverride) {
            // Change the uuid to allow on the same CN.
            var uuidEnd = '-ab0' + libuuid.create().slice(-9);
            params = {
                override_uuid: sourceVm.uuid.slice(0, -13) + uuidEnd,
                override_alias: cfg.vm.alias + uuidEnd
            };
        }

        // Trying to run a migration action when a migration has not started.
        client.post(
                {path: format('/vms/%s?action=migrate&migration_action=begin',
                    sourceVm.uuid)},
                params,
                function onMigrateBeginAbortCb(err, req, res, body) {
            common.ifError(t, err, 'no error when beginning the migration');
            if (!err) {
                t.ok(res, 'should get a restify response object');
                if (res) {
                    t.equal(res.statusCode, 202,
                        format('err.statusCode === 202, got %s',
                            res.statusCode));
                    t.ok(res.body, 'should get a restify response body object');
                }
                if (body) {
                    t.ok(body.job_uuid, 'got a job uuid: ' + body.job_uuid);
                    t.ok(body.migration, 'got a migration record');
                    if (body.migration) {
                        t.equal(body.migration.phase, 'begin',
                            'phase should be begin');
                        t.equal(body.migration.state, 'running',
                            'state should be running');
                    }

                    var waitParams = {
                        client: client,
                        job_uuid: body.job_uuid,
                        timeout: 15 * 60
                    };

                    waitForJob(waitParams, function onMigrationJobCb(jerr,
                            state, job) {
                        common.ifError(t, jerr, 'begin should be successful');
                        if (!jerr) {
                            migrationStarted = (state === 'succeeded');
                            t.equal(state, 'succeeded',
                                'Migration begin job should succeed - ' +
                                (migrationStarted ? 'ok' : getJobError(job)));
                        }
                        t.done();
                    });
                    return;
                }
            }
            t.done();
        });
    };

    test.migration_abort = function test_migration_abort(t) {
        if (!migrationStarted) {
            t.ok(false, 'VM migration did not begin successfully');
            t.done();
            return;
        }

        client.post(
                {path: format('/vms/%s?action=migrate&migration_action=abort',
                    sourceVm.uuid)},
                {},
                function onMigrateBeginAbortCb(err, req, res, body) {
            common.ifError(t, err, 'no error when aborting the migration');
            if (!err) {
                t.ok(res, 'should get a restify response object');
                if (res) {
                    t.equal(res.statusCode, 202,
                        format('err.statusCode === 202, got %s',
                            res.statusCode));
                    t.ok(res.body, 'should get a restify response body object');
                }
                if (body) {
                    t.ok(body.job_uuid, 'got a job uuid: ' + body.job_uuid);
                    t.ok(body.migration, 'got a migration record');
                    if (body.migration) {
                        t.equal(body.migration.phase, 'abort',
                            'phase should be abort');
                        t.equal(body.migration.state, 'running',
                            'state should be running');
                    }

                    var waitParams = {
                        client: client,
                        job_uuid: body.job_uuid,
                        timeout: 15 * 60
                    };

                    waitForJob(waitParams, function onMigrationJobCb(jerr,
                            state, job) {
                        common.ifError(t, jerr, 'abort should be successful');
                        if (!jerr) {
                            migrationStarted = (state === 'succeeded');
                            t.equal(state, 'succeeded',
                                'Migration abort job should succeed - ' +
                                (migrationStarted ? 'ok' : getJobError(job)));
                        }
                        t.done();
                    });
                    return;
                }
            }
            t.done();
        });
    };

    test.migration_begin = function test_migration_begin(t) {
        if (!sourceVm) {
            t.ok(false, 'Original VM was not created successfully');
            t.done();
            return;
        }

        migrationStarted = false;

        var params = {};

        if (migrationUuidOverride) {
            // Change the uuid to allow on the same CN.
            var uuidEnd = '-abc' + libuuid.create().slice(-9);
            params = {
                override_uuid: sourceVm.uuid.slice(0, -13) + uuidEnd,
                override_alias: cfg.vm.alias + uuidEnd
            };
        }

        // Trying to run a migration action when a migration has not started.
        client.post(
            { path:
                format('/vms/%s?action=migrate&migration_action=begin',
                    sourceVm.uuid) },
            params,
            function onMigrateBeginCb(err, req, res, body) {
            common.ifError(t, err, 'no error when beginning the migration');
            if (!err) {
                t.ok(res, 'should get a restify response object');
                if (res) {
                    t.equal(res.statusCode, 202,
                        format('err.statusCode === 202, got %s',
                            res.statusCode));
                    t.ok(res.body, 'should get a restify response body object');
                }
                if (body) {
                    t.ok(body.job_uuid, 'got a job uuid: ' + body.job_uuid);
                    t.ok(body.migration, 'got a migration record');
                    if (body.migration) {
                        t.equal(body.migration.phase, 'begin',
                            'phase should be begin');
                        t.equal(body.migration.state, 'running',
                            'state should be running');
                    }

                    // Watch for migration events.
                    createMigrationWatcher(sourceVm.uuid);

                    var waitParams = {
                        client: client,
                        job_uuid: body.job_uuid,
                        timeout: 15 * 60
                    };

                    waitForJob(waitParams, function onMigrationJobCb(jerr,
                            state, job) {
                        common.ifError(t, jerr, 'begin should be successful');
                        if (!jerr) {
                            migrationStarted = (state === 'succeeded');
                            t.equal(state, 'succeeded',
                                'Migration begin job should succeed - ' +
                                (migrationStarted ? 'ok' : getJobError(job)));
                        }
                        t.done();
                    });
                    return;
                }
            }
            t.done();
        });
    };

    test.check_watch_entries = function check_watch_entries(t) {

        t.ok(watcher, 'watcher exists');
        if (!watcher) {
            t.done();
            return;
        }

        var loopCount = 0;
        var timeoutSeconds = 2 * 60; // 2 minutes

        function waitForWatcherEnd() {
            loopCount += 1;
            if (!watcher.ended) {
                if (loopCount > timeoutSeconds) {
                    t.ok(false, 'Timed out waiting for the watcher to end');
                    t.done();
                    return;
                }
                setTimeout(waitForWatcherEnd, 1000);
                return;
            }

            // Check the events.
            t.ok(watcher.events.length > 0, 'Should be events seen');

            var beginEvents = watcher.events.filter(function _filtB(event) {
                return event.type === 'progress' && event.phase === 'begin';
            });
            t.ok(beginEvents.length > 0, 'Should have begin events');
            if (beginEvents.length > 0) {
                beginEvents.map(function (event) {
                    t.ok(event.state === 'running' ||
                        event.state === 'successful',
                        'event state running or successful');
                    t.ok(event.current_progress > 0, 'current_progress > 0');
                    t.equal(event.total_progress, 100, 'total_progress == 100');
                });
            }

            var endEvent = watcher.events.filter(function _filtEnd(event) {
                return event.type === 'end';
            }).slice(-1)[0];
            t.ok(endEvent, 'Should have an end event');
            if (endEvent) {
                t.equal(endEvent.phase, 'begin', 'end event phase is "begin"');
                t.equal(endEvent.state, 'paused', 'end event state "paused"');
            }

            destroyMigrationWatcher();

            t.done();
        }

        waitForWatcherEnd();
    };

    test.bad_migrate_cannot_begin_from_begin_phase = function (t) {
        // Invalid action according to the current migration phase.
        if (!migrationStarted) {
            t.ok(false, 'VM migration did not begin successfully');
            t.done();
            return;
        }

        client.post({
            path: format('/vms/%s?action=migrate&migration_action=begin',
                    sourceVm.uuid)
        }, function onMigrateNoAction(err) {
            t.ok(err, 'expect an error when the migration already started');
            if (err) {
                t.equal(err.statusCode, 412,
                    format('err.statusCode === 412, got %s', err.statusCode));
            }
            t.done();
        });
    };

    test.bad_migrate_cannot_pause_from_paused_state = function (t) {
        // Invalid action according to the current migration state.
        if (!migrationStarted) {
            t.ok(false, 'VM migration did not begin successfully');
            t.done();
            return;
        }

        client.post({
            path: format('/vms/%s?action=migrate&migration_action=pause',
                    sourceVm.uuid)
        }, function onMigrateNoAction(err) {
            t.ok(err, 'expect an error when the migration is already paused');
            if (err) {
                t.equal(err.statusCode, 412,
                    format('err.statusCode === 412, got %s', err.statusCode));
            }
            t.done();
        });
    };

    test.migration_list = function test_migration_list(t) {
        if (!migrationStarted) {
            t.ok(false, 'VM migration did not begin successfully');
            t.done();
            return;
        }

        client.get({
            path: '/migrations?format=raw'
        }, function onMigrateListCb(err, req, res, body) {
            common.ifError(t, err, 'no error expected when listing migrations');
            if (err) {
                t.done();
                return;
            }

            t.ok(res, 'should get a restify response object');
            if (!res) {
                t.done();
                return;
            }
            t.equal(res.statusCode, 200,
                format('err.statusCode === 200, got %s', res.statusCode));
            t.ok(Array.isArray(body), 'body response should be an array');
            if (!Array.isArray(body)) {
                t.done();
                return;
            }

            t.ok(body.length >= 1, 'should be at least one migration');
            if (body.length === 0) {
                t.done();
                return;
            }

            var migrations = body.filter(function _filtMig(entry) {
                return entry.vm_uuid === sourceVm.uuid;
            });
            t.ok(migrations.length >= 1, 'should be at least vm match');
            if (migrations.length === 0) {
                t.done();
                return;
            }

            var migration = migrations[0];
            t.equal(migration.automatic, false, 'automatic should be false');
            t.equal(migration.phase, 'begin', 'phase should be "begin"');
            t.equal(migration.state, 'paused', 'state should be "paused"');

            targetVm = jsprim.deepCopy(sourceVm);
            targetVm.uuid = migration.target_vm_uuid;
            targetVm.server_uuid = migration.target_server_uuid;

            t.ok(Array.isArray(migration.progress_history) &&
                    migration.progress_history.length >= 1,
                'migration should have at least one progress entry');
            if (!Array.isArray(migration.progress_history) ||
                    migration.progress_history.length === 0) {
                t.done();
                return;
            }

            var lastProgress = migration.progress_history.slice(-1)[0];
            t.equal(lastProgress.current_progress, 100,
                'current_progress should be 100');
            t.equal(lastProgress.total_progress, 100,
                'total_progress should be 100');
            t.equal(lastProgress.phase, 'begin', 'phase should be "begin"');
            t.equal(lastProgress.state, 'successful', 'state is "successful"');

            t.done();
        });
    };

    test.migration_sync = function test_migration_sync(t) {
        // Start the migration sync phase.
        if (!migrationStarted) {
            t.ok(false, 'VM migration did not begin successfully');
            t.done();
            return;
        }

        client.post({
            path: format('/vms/%s?action=migrate&migration_action=sync',
                sourceVm.uuid)
        }, function onMigrateSyncCb(err, req, res, body) {
            common.ifError(t, err, 'no error when syncing the migration');
            if (!err) {
                t.ok(res, 'should get a restify response object');
                if (res) {
                    t.equal(res.statusCode, 202,
                        format('err.statusCode === 202, got %s',
                            res.statusCode));
                    t.ok(res.body, 'should get a restify response body object');
                }
                if (body) {
                    t.ok(body.job_uuid, 'got a job uuid: ' + body.job_uuid);
                    t.ok(body.migration, 'got a migration record');
                    if (body.migration) {
                        t.equal(body.migration.phase, 'sync',
                            'phase should be sync');
                        t.equal(body.migration.state, 'running',
                            'state should be running');
                    }

                    // Watch for migration events.
                    createMigrationWatcher(sourceVm.uuid);

                    var waitParams = {
                        client: client,
                        job_uuid: body.job_uuid,
                        timeout: 1 * 60 * 60 // 1 hour
                    };

                    waitForJob(waitParams, function onMigrationJobCb(jerr,
                            state,
                            job) {
                        common.ifError(t, jerr,
                            'Migration (' + body.job_uuid
                            + ') sync should be successful');
                        if (!jerr) {
                            t.equal(state, 'succeeded',
                                'Migration sync job should succeed - ' +
                                (state === 'succeeded' ? 'ok' :
                                    getJobError(job)));
                        }
                        migrationSynced = (state === 'succeeded');
                        t.done();
                    });
                    return;
                }
            }
            t.done();
        });
    };

    test.check_watch_entries_after_sync =
    function check_watch_entries_after_sync(t) {

        t.ok(watcher, 'watcher exists');
        if (!watcher) {
            t.done();
            return;
        }

        var loopCount = 0;
        var timeoutSeconds = 5 * 60; // 5 minutes

        function waitForWatcherEnd() {
            loopCount += 1;
            if (!watcher.ended) {
                if (loopCount > timeoutSeconds) {
                    t.ok(false, 'Timed out waiting for the watcher to end');
                    t.done();
                    return;
                }
                setTimeout(waitForWatcherEnd, 1000);
                return;
            }

            // Check the events.
            t.ok(watcher.events.length > 0, 'Should be events seen');

            var syncEvents = watcher.events.filter(function _filtS(event) {
                return event.type === 'progress' && event.phase === 'sync';
            });
            t.ok(syncEvents.length > 0, 'Should have sync events');
            if (syncEvents.length > 0) {
                var sawBandwidthEvent = false;
                syncEvents.map(function (event) {
                    t.ok(event.state === 'running' ||
                        event.state === 'successful',
                        'event state running or successful');
                    t.ok(event.current_progress, 'event has current_progress');
                    t.ok(event.total_progress, 'event has a total_progress');
                    if (event.transfer_bytes_second) {
                        t.ok(event.hasOwnProperty('eta_ms'),
                            'event has a eta_ms');
                        sawBandwidthEvent = true;
                    }
                });

                if (sawBandwidthEvent) {
                    t.ok(sawBandwidthEvent, 'bandwidth progress event seen');
                } else {
                    // In the case of a fast sync, it's possible that a
                    // bandwidth event is not seen. So we let that slide if the
                    // sync action completed within 10 seconds.
                    var syncPhases = watcher.events.filter(
                            function _filterSyncPhases(event) {
                        return event.phase === 'sync' && event.duration_ms;
                    });
                    var lastSyncPhase = syncPhases.slice(-1)[0];
                    t.ok(lastSyncPhase,
                        'should have a sync phase with a duration_ms field');
                    if (lastSyncPhase) {
                        t.ok(lastSyncPhase.duration_ms < 10000,
                            'no bandwidth event seen due to fast sync (' +
                            lastSyncPhase.duration_ms + 'ms)');
                    }
                }
            }

            var endEvent = watcher.events.filter(function _filtEnd(event) {
                return event.type === 'end';
            }).slice(-1)[0];
            t.ok(endEvent, 'Should have an end event');
            if (endEvent) {
                t.equal(endEvent.phase, 'sync', 'end event phase is "sync"');
                t.equal(endEvent.state, 'paused', 'end event state "paused"');
            }

            destroyMigrationWatcher();

            t.done();
        }

        waitForWatcherEnd();
    };

    test.migration_sync_incremental = function test_migration_sync_inc(t) {
        // Start the migration sync phase again - should do an incremental sync.
        if (!migrationSynced) {
            t.ok(false, 'VM migration did not sync successfully');
            t.done();
            return;
        }

        client.post({
            path: format('/vms/%s?action=migrate&migration_action=sync',
                sourceVm.uuid)
        }, function onMigrateSyncCb(err, req, res, body) {
            common.ifError(t, err, 'no error when syncing the migration');
            if (!err) {
                t.ok(res, 'should get a restify response object');
                if (res) {
                    t.equal(res.statusCode, 202,
                        format('err.statusCode === 202, got %s',
                            res.statusCode));
                    t.ok(res.body, 'should get a restify response body object');
                }
                if (body) {
                    t.ok(body.job_uuid, 'got a job uuid: ' + body.job_uuid);
                    t.ok(body.migration, 'got a migration record');
                    if (body.migration) {
                        t.equal(body.migration.phase, 'sync',
                            'phase should be sync');
                        t.equal(body.migration.state, 'running',
                            'state should be running');
                    }

                    var waitParams = {
                        client: client,
                        job_uuid: body.job_uuid,
                        timeout: 1 * 60 * 60 // 1 hour
                    };

                    waitForJob(waitParams, function onMigrationJobCb(jerr,
                            state,
                            job) {
                        common.ifError(t, jerr, 'sync should be successful');
                        if (!jerr) {
                            t.equal(state, 'succeeded',
                                'Migration sync job should succeed - ' +
                                (state === 'succeeded' ? 'ok' :
                                    getJobError(job)));
                        }
                        migrationSynced = (state === 'succeeded');
                        t.done();
                    });
                    return;
                }
            }
            t.done();
        });
    };

    test.migration_switch = function test_migration_switch(t) {
        // Start the migration switch phase.
        if (!migrationStarted) {
            t.ok(false, 'VM migration did not begin successfully');
            t.done();
            return;
        }

        if (!migrationSynced) {
            t.ok(false, 'VM migration did not sync successfully');
            t.done();
            return;
        }

        client.post({
            path: format('/vms/%s?action=migrate&migration_action=switch',
                sourceVm.uuid)
        }, function onMigrateSwitchCb(err, req, res, body) {
            common.ifError(t, err, 'no error from migration switch call');
            if (!err) {
                t.ok(res, 'should get a restify response object');
                if (res) {
                    t.equal(res.statusCode, 202,
                        format('err.statusCode === 202, got %s',
                        res.statusCode));
                    t.ok(res.body, 'should get a restify response body object');
                }
                if (body) {
                    t.ok(body.job_uuid, 'got a job uuid: ' + body.job_uuid);
                    t.ok(body.migration, 'got a migration record');
                    if (body.migration) {
                        t.equal(body.migration.phase, 'switch',
                            'phase should be switch');
                        t.equal(body.migration.state, 'running',
                            'state should be running');
                    }

                    // Watch for migration events.
                    createMigrationWatcher(sourceVm.uuid);

                    var waitParams = {
                        client: client,
                        job_uuid: body.job_uuid,
                        timeout: 15 * 60 // 15 minutes
                    };

                    waitForJob(waitParams, function onMigrationJobCb(jerr,
                            state,
                            job) {
                        common.ifError(t, jerr, 'switch should be successful');
                        if (!jerr) {
                            t.equal(state, 'succeeded',
                                'Migration switch job should succeed - ' +
                                (state === 'succeeded' ? 'ok' :
                                    getJobError(job)));
                        }
                        migrationSwitched = (state === 'succeeded');
                        t.done();
                    });
                    return;
                }
            }
            t.done();
        });
    };

    test.migration_switched_list = function test_migration_switched_list(t) {
        if (!migrationSwitched) {
            t.ok(false, 'VM migration did not switch successfully');
            t.done();
            return;
        }

        client.get({
            path: '/migrations'
        }, function onMigrateListCb(err, req, res, body) {
            common.ifError(t, err, 'no error expected when listing migrations');
            if (err) {
                t.done();
                return;
            }

            t.ok(res, 'should get a restify response object');
            if (!res) {
                t.done();
                return;
            }
            t.equal(res.statusCode, 200,
                format('err.statusCode === 200, got %s', res.statusCode));
            t.ok(Array.isArray(body), 'body response should be an array');
            if (!Array.isArray(body)) {
                t.done();
                return;
            }

            t.ok(body.length >= 1, 'should be at least one migration');
            if (body.length === 0) {
                t.done();
                return;
            }

            var migrations = body.filter(function _filtMig(entry) {
                return entry.vm_uuid === sourceVm.uuid;
            });
            t.ok(migrations.length >= 1, 'should be at least vm match');
            if (migrations.length === 0) {
                t.done();
                return;
            }

            var migration = migrations[0];
            t.equal(migration.automatic, false, 'automatic should be false');
            t.equal(migration.phase, 'switch', 'phase should be "switch"');
            t.equal(migration.state, 'successful',
                'state should be "successful"');

            t.ok(Array.isArray(migration.progress_history) &&
                    migration.progress_history.length >= 5,
                'migration should have at least five progress entries');
            if (!Array.isArray(migration.progress_history) ||
                    migration.progress_history.length < 5) {
                t.done();
                return;
            }

            function checkProgressEntry(entry, phase) {
                t.equal(entry.phase, phase, 'phase should be "' + phase + '"');
                t.equal(entry.state, 'successful',
                    'progress state is "successful"');

                if (phase === 'sync') {
                    t.equal(entry.current_progress, entry.total_progress,
                        'current_progress should equal total_progress');
                } else {
                    t.equal(entry.current_progress, 100,
                        'current_progress is 100');
                    t.equal(entry.total_progress, 100, 'total_progress is 100');
                }
            }

            checkProgressEntry(migration.progress_history[0], 'begin');
            checkProgressEntry(migration.progress_history[1], 'sync');
            checkProgressEntry(migration.progress_history[2], 'sync');
            checkProgressEntry(migration.progress_history[3], 'sync');
            checkProgressEntry(migration.progress_history[4], 'switch');

            t.done();
        });
    };

    test.check_vmapi_state = function test_check_vmapi_state(t) {
        if (!targetVm) {
            t.ok(false, 'Vm was not migrated successfully');
            t.done();
            return;
        }

        // The original vm should no longer be visible in vmapi. We use
        // 'sync=true' to ensure vmapi (via cnapi) will use the most
        // up-to-date information.
        client.get({path: format('/vms/%s?sync=true', sourceVm.uuid)},
            onGetSourceVm);

        function onGetSourceVm(err, req, res, vm) {
            t.ifError(err, 'should not get an error fetching vm');
            if (res) {
                t.equal(res.statusCode, 200,
                    format('err.statusCode === 200, got %s', res.statusCode));
            }
            t.ok(vm, 'should get a vm object');
            if (vm) {
                // In the case of an override the vm should now be seen as
                // destroyed, else the vm will be active, but the server_uuid
                // will have changed.
                if (migrationUuidOverride) {
                    t.equal(vm.state, 'destroyed',
                        'original vm should have state destroyed');
                    t.equal(sourceVm.server_uuid, vm.server_uuid,
                        'vm server_uuid should be the same');
                } else {
                    t.notEqual(sourceVm.server_uuid, vm.server_uuid,
                        'vm server_uuid should be different');
                }

                // TRITON-1716 Ensure the create-timestamp has not changed.
                t.equal(sourceVm.create_timestamp, vm.create_timestamp,
                    'original create_timestamp should be maintained');
            }

            checkMigratedVm();
        }

        // The migrated vm *should* be visible through vmapi.
        function checkMigratedVm() {
            client.get({path: format('/vms/%s?sync=true', targetVm.uuid)},
                onGetMigratedVm);
        }

        var loopCount = 0;

        function onGetMigratedVm(err, req, res, vm) {
            common.ifError(t, err, 'should be no error fetching migrated vm');
            if (vm) {
                // When the migration is complete - it will be a while before
                // the zone has fully started up.
                if (vm.state !== 'running' && loopCount < 30) {
                    loopCount += 1;
                    setTimeout(checkMigratedVm, 2000);
                    return;
                }

                t.equal(vm.state, 'running', 'vm state should be "running"');
            }
            t.done();
        }
    };

    test.bad_migration_begin_from_state_switch =
            function test_bad_migration_begin_from_state_switch(t) {
        if (!targetVm) {
            t.ok(false, 'Target VM was not migrated successfully');
            t.done();
            return;
        }

        // It should not be possible to start another migration until the recent
        // migration is finalized.
        client.post({
            path: format('/vms/%s?action=migrate&migration_action=begin',
                sourceVm.uuid)
        }, function onMigrateBeginFromStateSuccessCb(err) {
            t.ok(err,
                'expect an error for migration begin when a previous ' +
                'migration exists');
            if (err) {
                t.equal(err.statusCode, 412,
                    format('err.statusCode === 412, got %s', err.statusCode));
            }
            t.done();
        });
    };

    test.migration_finalize = function test_migration_finalize(t) {
        if (!targetVm) {
            t.ok(false, 'Target VM was not migrated successfully');
            t.done();
            return;
        }

        client.post({
            path: format('/vms/%s?action=migrate&migration_action=finalize',
                sourceVm.uuid)
        }, function onMigrateFinalizeCb(err, req, res) {
            common.ifError(t, err, 'no error from migration finalize call');
            if (!err) {
                t.ok(res, 'should get a restify response object');
                if (res) {
                    t.equal(res.statusCode, 200,
                        format('err.statusCode === 200, got %s',
                            res.statusCode));
                }
            }
            t.done();
        });
    };

    test.migration_full = function test_migration_full(t) {
        if (!migrationSwitched) {
            t.ok(false, 'VM migration did not switch successfully');
            t.done();
            return;
        }

        sourceVm = targetVm;
        targetVm = null;

        var params = {
            action: 'migrate',
            migration_action: 'begin',
            migration_automatic: 'true'
        };

        if (migrationUuidOverride) {
            // Change the uuid to allow on the same CN.
            var uuidEnd = '-bbb' + libuuid.create().slice(-9);
            params.override_uuid = sourceVm.uuid.slice(0, -13) + uuidEnd;
            params.override_alias = cfg.vm.alias + uuidEnd;
        }

        client.post({path: format('/vms/%s', sourceVm.uuid)},
            params,
            onMigrateFullCb);

        function onMigrateFullCb(err, req, res, body) {
            common.ifError(t, err, 'no error when starting migration full');
            if (!err) {
                t.ok(res, 'should get a restify response object');
                if (res) {
                    t.equal(res.statusCode, 202,
                        format('statusCode === 202, got %s', res.statusCode));
                    t.ok(res.body, 'should get a restify response body object');
                }
                if (body) {
                    t.ok(body.job_uuid, 'got a job uuid: ' + body.job_uuid);
                    t.ok(body.migration, 'got a migration record');
                    if (body.migration) {
                        t.equal(body.migration.phase, 'begin',
                            'phase should be begin');
                        t.equal(body.migration.state, 'running',
                            'state should be running');
                    }

                    // Watch for migration events.
                    createMigrationWatcher(sourceVm.uuid);
                }
            }
            t.done();
        }
    };

    test.check_full_watch_entries = function check_full_watch_entries(t) {

        t.ok(watcher, 'watcher exists');
        if (!watcher) {
            t.done();
            return;
        }

        var loopCount = 0;
        var timeoutSeconds = 15 * 60; // 15 minutes

        function waitForWatcherEnd() {
            loopCount += 1;
            if (!watcher.ended) {
                if (loopCount > timeoutSeconds) {
                    t.ok(false, 'Timed out waiting for the watcher to end');
                    t.done();
                    return;
                }
                setTimeout(waitForWatcherEnd, 1000);
                return;
            }

            // Check the events.
            t.ok(watcher.events.length > 0, 'Should be events seen');

            var beginEvents = watcher.events.filter(function _filtB(event) {
                return event.type === 'progress' && event.phase === 'begin';
            });
            t.ok(beginEvents.length > 0, 'Should have begin events');
            if (beginEvents.length > 0) {
                beginEvents.map(function (event) {
                    t.ok(event.state === 'running' ||
                        event.state === 'successful',
                        'event state running or successful');
                    t.ok(event.current_progress > 0, 'current_progress > 0');
                    t.equal(event.total_progress, 100, 'total_progress == 100');
                });
            }

            var syncEvents = watcher.events.filter(function _filt(event) {
                return event.type === 'progress' && event.phase === 'sync';
            });
            t.ok(syncEvents.length > 0, 'Should have sync events');
            if (syncEvents.length > 0) {
                // There should be at least three distinct sync phases.
                var syncStartEvents = syncEvents.filter(function _filtS(event) {
                    return event.message === 'syncing data';
                });
                t.ok(syncStartEvents.length >= 3, 'Should have at least 3 ' +
                    'different sync events');
                var sawBandwidthEvent = false;
                syncEvents.map(function (event) {
                    // All sync events should have state 'running'
                    t.ok(event.state === 'running', 'event state is "running"');
                    t.ok(event.current_progress, 'event has current_progress');
                    t.ok(event.total_progress, 'event has a total_progress');
                    if (event.transfer_bytes_second) {
                        t.ok(event.hasOwnProperty('eta_ms'),
                            'event has a eta_ms');
                        sawBandwidthEvent = true;
                    }
                });

                if (sawBandwidthEvent) {
                    t.ok(sawBandwidthEvent, 'bandwidth progress event seen');
                } else {
                    // In the case of a fast sync, it's possible that a
                    // bandwidth event is not seen. So we let that slide if the
                    // sync action completed within 10 seconds.
                    var syncPhases = watcher.events.filter(
                            function _filterSyncPhases(event) {
                        return event.phase === 'sync' && event.duration_ms;
                    });
                    var lastSyncPhase = syncPhases.slice(-1)[0];
                    t.ok(lastSyncPhase,
                        'should have a sync phase with a duration_ms field');
                    if (lastSyncPhase) {
                        t.ok(lastSyncPhase.duration_ms < 10000,
                            'no bandwidth event seen due to fast sync (' +
                            lastSyncPhase.duration_ms + 'ms)');
                    }
                }
            }

            var endEvent = watcher.events.filter(function _filtEnd(event) {
                return event.type === 'end';
            }).slice(-1)[0];
            t.ok(endEvent, 'Should have an end event');
            if (endEvent) {
                t.equal(endEvent.phase, 'switch',
                    'end event phase is "switch"');
                t.equal(endEvent.state, 'successful',
                    'end event state is "successful"');
            }

            destroyMigrationWatcher();

            t.done();
        }

        waitForWatcherEnd();
    };

    test.migration_get = function test_migration_get(t) {
        client.get({
            path: '/migrations/' + sourceVm.uuid + '?format=raw'
        }, function onMigrateGetCb(err, req, res, migration) {
            common.ifError(t, err, 'no error for migration get');
            if (err) {
                t.done();
                return;
            }

            assert.object(migration, 'migration object');

            targetVm = jsprim.deepCopy(sourceVm);
            targetVm.uuid = migration.target_vm_uuid;
            targetVm.server_uuid = migration.target_server_uuid;

            t.done();
        });
    };

    test.check_vmapi_state_2 = function test_check_vmapi_state_2(t) {
        if (!targetVm) {
            t.ok(false, 'Vm was not migrated successfully');
            t.done();
            return;
        }

        // The source vm should no longer be visible in vmapi. We use
        // 'sync=true' to ensure vmapi (via cnapi) will use the most
        // up-to-date information.
        client.get({path: format('/vms/%s?sync=true', sourceVm.uuid)},
            onGetSourceVm);

        function onGetSourceVm(err, req, res, vm) {
            common.ifError(t, err, 'should not error fetching source vm');
            if (res) {
                t.equal(res.statusCode, 200,
                    format('err.statusCode === 200, got %s', res.statusCode));
            }
            t.ok(vm, 'should get a vm object');
            if (vm) {
                // In the case of an override the vm should now be seen as
                // destroyed, else the vm will be active, but the server_uuid
                // will have changed.
                if (migrationUuidOverride) {
                    t.equal(vm.state, 'destroyed',
                        'original vm should have state destroyed');
                    t.equal(sourceVm.server_uuid, vm.server_uuid,
                        'vm server_uuid should be the same');
                } else {
                    t.notEqual(sourceVm.server_uuid, vm.server_uuid,
                        'vm server_uuid should be different');
                }

                // TRITON-1716 Ensure the create-timestamp has not changed.
                t.equal(sourceVm.create_timestamp, vm.create_timestamp,
                    'original create_timestamp should be maintained');
            }

            checkMigratedVm();
        }

        // The migrated vm *should* be visible through vmapi.
        function checkMigratedVm() {
            client.get({path: format('/vms/%s?sync=true', targetVm.uuid)},
                onGetMigratedVm);
        }

        var loopCount = 0;

        function onGetMigratedVm(err, req, res, vm) {
            common.ifError(t, err, 'should be no error fetching migrated vm');
            if (vm) {
                // When the migration is complete - it will be a while before
                // the zone has fully started up.
                if (vm.state !== 'running' && loopCount < 30) {
                    loopCount += 1;
                    setTimeout(checkMigratedVm, 2000);
                    return;
                }

                t.equal(vm.state, 'running', 'vm state should be "running"');
            }
            t.done();
        }
    };

    test.migration_rollback = function test_migration_rollback(t) {
        if (!targetVm) {
            t.ok(false, 'Target VM was not migrated successfully');
            t.done();
            return;
        }

        client.post({
            path: format('/vms/%s?action=migrate&migration_action=rollback',
                sourceVm.uuid)
        }, function onMigrateRollbackCb(err, req, res, body) {
            common.ifError(t, err, 'no error from migration rollback call');
            if (!err) {
                t.ok(res, 'should get a restify response object');
                if (res) {
                    t.equal(res.statusCode, 202,
                        format('err.statusCode === 202, got %s',
                            res.statusCode));
                    t.ok(res.body, 'should get a restify response body object');
                }
                if (body) {
                    t.ok(body.job_uuid, 'got a job uuid: ' + body.job_uuid);
                    t.ok(body.migration, 'got a migration record');
                    if (body.migration) {
                        t.equal(body.migration.phase, 'rollback',
                            'phase should be rollback');
                        t.equal(body.migration.state, 'running',
                            'state should be running');
                    }

                    var waitParams = {
                        client: client,
                        job_uuid: body.job_uuid,
                        timeout: 20 * 60 // 20 minutes
                    };

                    waitForJob(waitParams, function onMigrationJobCb(jerr,
                            state,
                            job) {
                        common.ifError(t, jerr,
                            'rollback should be successful');
                        if (!jerr) {
                            t.equal(state, 'succeeded',
                                'Migration rollback job should succeed - ' +
                                (state === 'succeeded' ? 'ok' :
                                    getJobError(job)));
                        }
                        migrationRolledBack = (state === 'succeeded');
                        t.done();
                    });
                    return;
                }
            }
            t.done();
        });
    };

    test.check_vmapi_state_after_rollback =
            function test_check_vmapi_state_after_rollback(t) {
        if (!migrationRolledBack) {
            t.ok(false, 'Vm did not rollback successfully');
            t.done();
            return;
        }

        // The target vm should no longer be visible in vmapi. We use
        // 'sync=true' to ensure vmapi (via cnapi) will use the most up-to-date
        // information.
        client.get({path: format('/vms/%s?sync=true', targetVm.uuid)},
            onGetTargetVm);

        function onGetTargetVm(err, req, res, vm) {
            common.ifError(t, err, 'should not error fetching target vm');
            if (res) {
                t.equal(res.statusCode, 200,
                    format('err.statusCode === 200, got %s', res.statusCode));
            }
            t.ok(vm, 'should get a vm object');
            if (vm) {
                // In the case of an override the vm should now be seen as
                // destroyed, else the vm will be active, but the server_uuid
                // will have changed.
                if (migrationUuidOverride) {
                    t.equal(vm.state, 'destroyed',
                        'original vm should have state destroyed');
                    t.equal(targetVm.server_uuid, vm.server_uuid,
                        'vm server_uuid should be the same');
                } else {
                    t.equal(sourceVm.server_uuid, vm.server_uuid,
                        'vm server_uuid should be the source server uuid');
                    t.notEqual(targetVm.server_uuid, vm.server_uuid,
                        'vm target server_uuid should be different');
                }
            }

            t.done();
        }
    };

    test.cleanup = function test_cleanup(t) {
        if (!sourceVm) {
            t.ok(false, 'source vm not found, cannot delete VM');
            t.done();
            return;
        }

        client.del({
            path: '/vms/' + targetVm.uuid
        }, function onVmDeleted(err, req, res) {
            common.ifError(t, err, 'vm delete target should not error');
            t.done();
        });
    };
}

function updateVmAndWait(t, client, vmUuid, payload, cb) {
    var postOpts = {
        path: format('/vms/%s?action=update', vmUuid)
    };

    client.post(postOpts, payload, function onPost(err, req, res, body) {
        t.ifError(err, 'update should succeed');

        t.ok(body.job_uuid, 'got a job uuid in the begin response');
        var waitParams = {
            client: client,
            job_uuid: body.job_uuid,
            timeout: 15 * 60
        };

        waitForJob(waitParams, function onUpdateJobCb(jerr, state, job) {
            t.ifError(jerr, 'update job should be successful');
            t.done();
        });
    });
}


module.exports = {
    TestMigrationCfg: TestMigrationCfg
};
