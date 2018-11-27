/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
 */

/*
 * Plan:
 *  - test bad actions (no migration, ...)
 *  - provision vm
 *  - test bad actions
 *  - migrate start (no sync or switch)
 *  - test bad actions (starting migrate again...)
 *  - abort (destroys the provisioned vm)
 */

var stream = require('stream');
var util = require('util');

var assert = require('assert-plus');
var byline = require('byline');
var restify = require('restify');
var vasync = require('vasync');

var common = require('./common');
var testUuid = require('./lib/uuid');

var format = util.format;
var waitForValue = common.waitForValue;
var waitForJob = common.waitForJob;


/* Globals */

var ADMIN_USER_UUID = common.config.ufdsAdminUuid;
var ADMIN_FABRIC_NETWORK;
var VMAPI_ORIGIN_IMAGE_UUID;
var SERVER;
var VM_UUID;
var VM_PAYLOAD;

var client;
var mig = {};

/* Helper functions */

function getVmPayloadTemplate() {
    return {
        alias: 'vmapitest-migrate-' + testUuid.generateShortUuid(),
        owner_uuid: ADMIN_USER_UUID,
        image_uuid: VMAPI_ORIGIN_IMAGE_UUID,
//         server_uuid: SERVER.uuid,
        networks: [ { uuid: ADMIN_FABRIC_NETWORK.uuid } ],
        brand: 'joyent-minimal',
//         billing_id: '00000000-0000-0000-0000-000000000000',
        billing_id: '2b7e38e2-b744-47fa-8b37-c5db20120d85' // Sample-1G
//         ram: 1024,
//         quota: 10,
//         cpu_cap: 100
    };
}

function getJobError(job) {
    if (job && job.chain_results && job.chain_results.length > 0) {
        // Get the error from the last task in the job.
        return JSON.stringify(job.chain_results.slice(-1)[0].error);
    }
    return null;
}

function logJobError(t, job, message) {
    var errMsg = getJobError(job);
    if (errMsg) {
        t.ok(false, message + ': ' + errMsg);
    }
}

function MigrationWatcher(vm_uuid) {
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

    var httpVmapi = restify.createHttpClient({url: client.url.href});

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

function createMigrationWatcher() {
    mig.watcher = new MigrationWatcher(VM_UUID);
    mig.watcher.start();
}

/* Tests */

exports.setUp = function (callback) {
    common.setUp(function (err, _client) {
        assert.ifError(err);
        assert.ok(_client, 'restify client');
        client = _client;
        callback();
    });
};

exports.get_vmapi_origin_image = function (t) {
    var vmapiVmImgUuid;

    vasync.pipeline({funcs: [
        function getVmapiImg(ctx, next) {
            client.get('/vms?alias=vmapi&tag.smartdc_type=core',
                function onListVms(listVmsErr, req, res, vms) {
                    t.ifError(listVmsErr);
                    t.ok(vms, 'listing VMAPI core VMs should result in a ' +
                        'non-empty response');

                    vmapiVmImgUuid = vms[0].image_uuid;

                    next();
                });
        },

        function getOrigImg(ctx, next) {
            client.imgapi.get('/images/' + vmapiVmImgUuid,
                function onGetImage(getImgErr, req, res, image) {
                    t.ifError(getImgErr);
                    t.ok(image, 'Listing VMAPI\'s VM\'s image should result ' +
                        'in a non-empty response');

                    VMAPI_ORIGIN_IMAGE_UUID = image.origin;

                    next();
                });
        }
    ]}, function onVmapiOriginImgRetrieved(err) {
        t.ifError(err);
        t.done();
    });
};

exports.get_admin_fabric_network = function (t) {
    client.napi.get('/networks?owner_uuid=' + ADMIN_USER_UUID + '&fabric=true',
        function (err, req, res, networks) {
        console.dir(networks);
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        t.ok(networks, 'networks is set');
        t.ok(Array.isArray(networks), 'networks is Array');
        t.ok(networks.length === 1, '1 network found');

        ADMIN_FABRIC_NETWORK = networks[0];
        t.ok(ADMIN_FABRIC_NETWORK,
            'Admin fabric network should have been found');

        t.done();
    });
};

exports.find_headnode = function (t) {
    common.findHeadnode(t, client, function _findHeadnodeCb(err, headnode) {
        common.ifError(t, err);
        SERVER = headnode;
        t.done();
    });
};

exports.get_vm_payload_template = function (t) {
    VM_PAYLOAD = getVmPayloadTemplate();
    t.done();
};

exports.create_vm = function (t) {
    if (process.env.MIGRATION_VM_UUID) {
        VM_UUID = process.env.MIGRATION_VM_UUID;
        t.done();
        return;
    }

    vasync.pipeline({arg: {}, funcs: [

        function createVm(ctx, next) {
            client.post({
                path: '/vms'
            }, VM_PAYLOAD, function onVmCreated(err, req, res, body) {
                var expectedResStatusCode = 202;

                t.ifError(err, 'VM creation should not error');
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
                VM_UUID = body.vm_uuid;
                console.log('# Vm uuid: ' + VM_UUID);

                next();
            });
        },

        function waitForProvisioningJob(ctx, next) {
            waitForValue('/jobs/' + ctx.jobUuid, 'execution', 'succeeded',
                { client: client, timeout: 10 * 60 },
                function onVmProvisioned(err) {
                    t.ifError(err, 'VM should be provisioned successfully');
                    next();
                });
        },
        function getVmServer(ctx, next) {
            client.get('/vms/' + VM_UUID, function (err, req, res, body) {
                t.ifError(err, 'VM should appear in vmapi');
                console.log('the server uuid');
                console.dir(SERVER.UUID);
                next();
            });
        }
    ]}, function _provisionPipelineCb(err) {
        common.ifError(t, err);
        t.done();
    });
};


exports.bad_migrate_no_action = function (t) {
    // No action.
    client.post({
        path: format('/vms/%s?action=migrate', VM_UUID)
    }, function onMigrateNoAction(err) {
        t.ok(err, 'expect an error when no migration action supplied');
        if (err) {
            t.equal(err.statusCode, 409,
                format('err.statusCode === 409, got %s', err.statusCode));
        }
        t.done();
    });
};

exports.bad_migrate_unknown_action = function (t) {
    // Unknown migration action.
    client.post({
        path: format('/vms/%s?action=migrate&migration_action=unknown', VM_UUID)
    }, function onMigrateNoAction(err) {
        t.ok(err, 'expect an error for an unknown migration action');
        if (err) {
            t.equal(err.statusCode, 409,
                format('err.statusCode === 409, got %s', err.statusCode));
        }
        t.done();
    });
};

if (!process.env.MIGRATION_SKIP_START) {
[
    'abort',
    'pause',
    'switch',
    'sync'
].forEach(function _testNoMigrateForEach(action) {
    exports['bad_migrate_' + action + '_when_no_migration'] = function (t) {
        // Try to run a migration action when no migration has been started.
        client.post({
            path: format('/vms/%s?action=migrate&migration_action=%s',
                VM_UUID, action)
        }, function onMigrateNoMigrationDataCb(err) {
            t.ok(err, 'expect an error when there is no migration entry');
            if (err) {
                t.equal(err.statusCode, 404,
                    format('err.statusCode === 404, got %s', err.statusCode));
            }
            t.done();
        });
    };
});
}

exports.bad_migrate_core_zone = function (t) {
    // Should not be able to migrate a triton core zone.
    vasync.pipeline({arg: {}, funcs: [
        function findCoreZone(ctx, next) {
            client.get({
                path: '/vms?tag.smartdc_type=core&state=active&limit=1'
            }, function onFindCoreZone(err, req, res, body) {
                if (err) {
                    t.ok(false, 'unable to query vmapi for core zone: ' + err);
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
                path: format('/vms/%s?action=migrate&migration_action=start',
                    ctx.vm.uuid)
            }, function onMigrateCoreZoneCb(err) {
                t.ok(err, 'expect an error for migration of a core zone');
                if (err) {
                    t.equal(err.statusCode, 409,
                        format('err.statusCode === 409, got %s',
                            err.statusCode));
                }
                next();
            });
        }
    ]}, function _pipelineCb() {
        t.done();
    });
};

exports.bad_migrate_nat_zone = function (t) {
    // Should not be able to migrate a triton NAT zone.
    vasync.pipeline({arg: {}, funcs: [
        function findNatZone(ctx, next) {
            client.get({
                path: '/vms?tag.smartdc_role=nat&state=active&limit=1'
            }, function onFindNatZone(err, req, res, body) {
                if (err) {
                    t.ok(false, 'unable to query vmapi for nat zone: ' + err);
                    next(true);
                    return;
                }
                if (!body || !body[0] || !body[0].uuid) {
                    t.ok(false, 'no nat zone found');
                    next(true);
                    return;
                }
                ctx.vm = body[0];
                next();
            });
        },

        function migrateNatZone(ctx, next) {
            client.post({
                path: format('/vms/%s?action=migrate&migration_action=start',
                    ctx.vm.uuid)
            }, function onMigrateNatZoneCb(err) {
                t.ok(err, 'expect an error for migration of a nat zone');
                if (err) {
                    t.equal(err.statusCode, 409,
                        format('err.statusCode === 409, got %s',
                            err.statusCode));
                }
                next();
            });
        }
    ]}, function _pipelineCb() {
        t.done();
    });
};

exports.migration_start = function test_migration_start(t) {
    if (process.env.MIGRATION_SKIP_START) {
        t.ok(true, 'Skip - VM migration start has been skipped');
        mig.started = true;
        t.done();
        return;
    }

    // XXX: Testing - tweak the uuid to allow on the same CN.
    var override_uuid = VM_UUID.slice(0, -6) + 'aaaaaa';
    var override_alias = getVmPayloadTemplate().alias + '-aaaaaa';

    // Trying to run a migration action when there a migration has not started.
    client.post(
        { path:
            format('/vms/%s?action=migrate&migration_action=start', VM_UUID) },
        { override_uuid: override_uuid, override_alias: override_alias },
        function onMigrateStartCb(err, req, res, body) {
        t.ifError(err, 'no error expected when starting the migration');
        if (!err) {
            t.ok(res, 'should get a restify response object');
            if (res) {
                t.equal(res.statusCode, 202,
                    format('err.statusCode === 202, got %s', res.statusCode));
                t.ok(res.body, 'should get a restify response body object');
            }
            if (body) {
                console.log(body);
                t.ok(body.job_uuid, 'got a job uuid in the start response');

                var waitParams = {
                    client: client,
                    job_uuid: body.job_uuid,
                    timeout: 15 * 60
                };

                waitForJob(waitParams, function onMigrationJobCb(jerr, state,
                        job) {
                    t.ifError(jerr, 'Migration start should be successful');
                    if (!jerr) {
                        mig.started = (state === 'succeeded');
                        t.equal(state, 'succeeded',
                            'Migration start job should succeed - ' +
                            (mig.started ? 'ok' : getJobError(job)));
                    }
                    t.done();
                });
                return;
            }
        }
        t.done();
    });
};

exports.check_watch_entries = function check_watch_entries(t) {
    createMigrationWatcher();

    assert.object(mig.watcher, 'mig.watcher');

    var loopCount = 0;

    function waitForWatcherEnd() {
        loopCount += 1;
        if (!mig.watcher.ended) {
            if (loopCount > 60) {
                t.ok(false, 'Timed out waiting for the watcher to end');
                t.done();
                return;
            }
            setTimeout(waitForWatcherEnd, 1000);
            return;
        }

        // Check the events.
        t.ok(mig.watcher.events.length > 0, 'Should be events seen');

        var startEvent = mig.watcher.events.filter(function _filtStart(event) {
            return event.phase === 'start';
        }).slice(-1)[0];
        t.ok(startEvent, 'Should have a start event');
        if (startEvent) {
            t.equal(startEvent.state, 'success', 'event state was success');
            t.equal(startEvent.current_progress, 100, 'current_progress');
            t.equal(startEvent.total_progress, 100, 'total_progress');
            t.ok(startEvent.started_timestamp, 'event has started_timestamp');
            t.ok(startEvent.finished_timestamp, 'event has finished_timestamp');
        }

        t.done();
    }

    waitForWatcherEnd();
};

exports.bad_migrate_cannot_start_from_start_phase = function (t) {
    // Invalid action according to the current migration phase.
    if (!mig.started) {
        t.ok(false, 'VM migration did not start successfully');
        t.done();
        return;
    }

    client.post({
        path: format('/vms/%s?action=migrate&migration_action=start',
                 VM_UUID)
    }, function onMigrateNoAction(err) {
        t.ok(err, 'expect an error when the migration already started');
        if (err) {
            t.equal(err.statusCode, 409,
                format('err.statusCode === 409, got %s', err.statusCode));
        }
        t.done();
    });
};

exports.bad_migrate_cannot_pause_from_paused_state = function (t) {
    // Invalid action according to the current migration state.
    if (!mig.started) {
        t.ok(false, 'VM migration did not start successfully');
        t.done();
        return;
    }

    client.post({
        path: format('/vms/%s?action=migrate&migration_action=pause',
                 VM_UUID)
    }, function onMigrateNoAction(err) {
        t.ok(err, 'expect an error when the migration is already paused');
        if (err) {
            t.equal(err.statusCode, 409,
                format('err.statusCode === 409, got %s', err.statusCode));
        }
        t.done();
    });
};

exports.migration_list = function test_migration_list(t) {
    client.get({
        path: '/migrations'
    }, function onMigrateListCb(err, req, res, body) {
        t.ifError(err, 'no error expected when listing migrations');
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
            return entry.vm_uuid === VM_UUID;
        });
        t.ok(migrations.length >= 1, 'should be at least vm match');
        if (migrations.length === 0) {
            t.done();
            return;
        }

        var migration = migrations.slice(-1)[0];
        t.equal(migration.automatic, false, 'automatic should be false');
        t.equal(migration.phase, 'start', 'phase should be "start"');
        t.equal(migration.state, 'paused', 'state should be "paused"');
        t.equal(migration.vm_uuid, VM_UUID, 'vm_uuid should be the same');

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
        t.equal(lastProgress.phase, 'start', 'phase should be "start"');
        t.equal(lastProgress.state, 'success', 'state should be "success"');

        t.done();
    });
};

exports.migration_sync = function test_migration_sync(t) {
    // Start the migration sync phase.
    if (!mig.started) {
        t.ok(false, 'VM migration did not start successfully');
        t.done();
        return;
    }

    client.post({
        path: format('/vms/%s?action=migrate&migration_action=sync', VM_UUID)
    }, function onMigrateSyncCb(err, req, res, body) {
        t.ifError(err, 'no error expected when syncing the migration');
        if (!err) {
            t.ok(res, 'should get a restify response object');
            if (res) {
                t.equal(res.statusCode, 202,
                    format('err.statusCode === 202, got %s', res.statusCode));
                t.ok(res.body, 'should get a restify response body object');
            }
            if (body) {
                console.log(body);
                t.ok(body.job_uuid, 'got a job uuid in the sync response');

                var waitParams = {
                    client: client,
                    job_uuid: body.job_uuid,
                    timeout: 1 * 60 * 60 // 1 hour
                };

                waitForJob(waitParams, function onMigrationJobCb(jerr, state,
                        job) {
                    t.ifError(jerr,
                        'Migration (' + body.job_uuid
                        + ') sync should be successful');
                    if (!jerr) {
                        t.equal(state, 'succeeded',
                            'Migration sync job should succeed - ' +
                            (state === 'succeeded' ? 'ok' : getJobError(job)));
                    }
                    mig.synced = (state === 'succeeded');
                    t.done();
                });
                return;
            }
        }
        t.done();
    });
};

exports.check_watch_entries_after_sync =
function check_watch_entries_after_sync(t) {
    createMigrationWatcher();

    assert.object(mig.watcher, 'mig.watcher');

    var loopCount = 0;

    function waitForWatcherEnd() {
        loopCount += 1;
        if (!mig.watcher.ended) {
            if (loopCount > 60) {
                t.ok(false, 'Timed out waiting for the watcher to end');
                t.done();
                return;
            }
            setTimeout(waitForWatcherEnd, 1000);
            return;
        }

        // Check the events.
        t.ok(mig.watcher.events.length > 0, 'Should be events seen');

        var startEvent = mig.watcher.events.filter(function _filtStart(event) {
            return event.phase === 'start';
        }).slice(-1)[0];
        t.ok(startEvent, 'Should have a start event');
        if (startEvent) {
            t.equal(startEvent.state, 'success', 'event state was success');
            t.equal(startEvent.current_progress, 100, 'current_progress');
            t.equal(startEvent.total_progress, 100, 'total_progress');
            t.ok(startEvent.started_timestamp, 'event has started_timestamp');
            t.ok(startEvent.finished_timestamp, 'event has finished_timestamp');
        }

        var syncEvent = mig.watcher.events.filter(function _filtSync(event) {
            return event.phase === 'sync';
        }).slice(-1)[0];
        t.ok(syncEvent, 'Should have a sync event');
        if (syncEvent) {
            t.equal(syncEvent.state, 'success', 'event state was success');
            t.ok(syncEvent.current_progress, 'event has a current_progress');
            t.ok(syncEvent.total_progress, 'event has a total_progress');
            t.ok(syncEvent.started_timestamp, 'event has started_timestamp');
            t.ok(syncEvent.finished_timestamp, 'event has finished_timestamp');
        }

        t.done();
    }

    waitForWatcherEnd();
};

exports.migration_sync_incremental = function test_migration_sync_inc(t) {
    // Start the migration sync phase again - should do an incremental sync.
    if (!mig.synced) {
        t.ok(false, 'VM migration did not sync successfully');
        t.done();
        return;
    }

    client.post({
        path: format('/vms/%s?action=migrate&migration_action=sync', VM_UUID)
    }, function onMigrateSyncCb(err, req, res, body) {
        t.ifError(err, 'no error expected when syncing the migration');
        if (!err) {
            t.ok(res, 'should get a restify response object');
            if (res) {
                t.equal(res.statusCode, 202,
                    format('err.statusCode === 202, got %s', res.statusCode));
                t.ok(res.body, 'should get a restify response body object');
            }
            if (body) {
                console.log(body);
                t.ok(body.job_uuid, 'got a job uuid in the sync response');

                var waitParams = {
                    client: client,
                    job_uuid: body.job_uuid,
                    timeout: 1 * 60 * 60 // 1 hour
                };

                waitForJob(waitParams, function onMigrationJobCb(jerr, state,
                        job) {
                    t.ifError(jerr, 'Migration sync should be successful');
                    if (!jerr) {
                        t.equal(state, 'succeeded',
                            'Migration sync job should succeed - ' +
                            (state === 'succeeded' ? 'ok' : getJobError(job)));
                    }
                    mig.synced = (state === 'succeeded');
                    t.done();
                });
                return;
            }
        }
        t.done();
    });
};

exports.migration_switch = function test_migration_switch(t) {
    if (1 || 0) {
        t.ok(true, 'SKIP - not performing switch');
        t.done();
        return;
    }

    // Start the migration switch phase.
    if (!mig.started) {
        t.ok(false, 'VM migration did not start successfully');
        t.done();
        return;
    }

    if (!mig.synced) {
        t.ok(false, 'VM migration did not sync successfully');
        t.done();
        return;
    }

    client.post({
        path: format('/vms/%s?action=migrate&migration_action=switch', VM_UUID)
    }, function onMigrateSwitchCb(err, req, res, body) {
        t.ifError(err, 'no error expected when switching the migration');
        if (!err) {
            t.ok(res, 'should get a restify response object');
            if (res) {
                t.equal(res.statusCode, 202,
                    format('err.statusCode === 202, got %s', res.statusCode));
                t.ok(res.body, 'should get a restify response body object');
            }
            if (body) {
                console.log(body);
                t.ok(body.job_uuid, 'got a job uuid in the switch response');

                var waitParams = {
                    client: client,
                    job_uuid: body.job_uuid,
                    timeout: 15 * 60 // 15 minutes
                };

                waitForJob(waitParams, function onMigrationJobCb(jerr, state,
                        job) {
                    t.ifError(jerr, 'Migration switch should be successful');
                    if (!jerr) {
                        t.equal(state, 'succeeded',
                            'Migration switch job should succeed - ' +
                            (state === 'succeeded' ? 'ok' : getJobError(job)));
                    }
                    t.done();
                });
                return;
            }
        }
        t.done();
    });
};

exports.cleanup = function test_cleanup(t) {
    if (process.env.MIGRATION_VM_UUID) {
        t.done();
        return;
    }

    if (!VM_UUID) {
        t.ok(false, 'VM_UUID not found, cannot delete VM');
        t.done();
        return;
    }

    client.del({
        path: format('/vms/%s?sync=true', VM_UUID)
    }, function onVmDelete(err) {
        t.ifError(err, 'Deleting VM ' + VM_UUID + ' should succeed');

        // XXX: This deletes the temporarily renamed (hack) migrated instance.
        var hackVm = VM_UUID.slice(0, -6) + 'aaaaaa';
        client.del({
            path: format('/vms/%s?sync=true', hackVm)
        }, function onHackVmDelete(err2) {
            t.ifError(err2, 'Deleting hackVM ' + hackVm + ' should succeed');
            t.done();
        });
    });
};
