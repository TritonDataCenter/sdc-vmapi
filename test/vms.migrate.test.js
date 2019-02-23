/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * Migration test plan overview:
 *  test bad actions (no migration, ...)
 *  provision test vm (which will later be migrated)
 *    test bad actions
 *  migrate begin
 *    test bad actions (starting migrate again...)
 *    abort (destroys the provisioned vm from begin)
 *  migrate begin
 *    test migrate watch
 *    migrate sync
 *      test migrate watch
 *    migrate sync again
 *    migrate switch
 *      test migrate watch
 *  migrate full (begin, sync, switch)
 *    test migrate watch
 *    migrate cleanup (delete original vm)
 *  test cleanup
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
var VM_UUID;
var VM_PAYLOAD;
var BILLING_ID;
// var NGINX_IMAGE_UUID = '2d7ec6d2-f100-11e5-84d7-77c57246a64a';

var client;
var mig = {
    vms: {}, // vmobject by their vm_uuid
    dni_vm_uuids: []
};

/* Helper functions */

function getVmPayloadTemplate() {
    return {
        alias: 'vmapitest-migrate-' + testUuid.generateShortUuid(),
        owner_uuid: ADMIN_USER_UUID,
        image_uuid: VMAPI_ORIGIN_IMAGE_UUID,
        // image_uuid: NGINX_IMAGE_UUID,
        networks: [ { uuid: ADMIN_FABRIC_NETWORK.uuid } ],
        brand: 'joyent-minimal',
        billing_id: BILLING_ID
    };
}

function getJobError(job) {
    if (job && job.chain_results && job.chain_results.length > 0) {
        // Get the error from the last task in the job.
        return JSON.stringify(job.chain_results.slice(-1)[0].error);
    }
    return null;
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

function createMigrationWatcher(vm_uuid) {
    mig.watcher = new MigrationWatcher(vm_uuid);
    mig.watcher.start();
}

function destroyMigrationWatcher() {
    delete mig.watcher;
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

exports.get_package = function (t, cb) {
    // look for sdc_64
    client.papi.get('/packages', getPackages);
    function getPackages(err, req, res, packages) {
        common.ifError(t, err, 'getting packages');
        // console.dir(packages);

        var found = packages.filter(function (p) {
            return p.name === 'sdc_64';
        });

        t.equal(found.length, 1, 'found package');

        BILLING_ID = found[0].uuid;
        t.done();
    }
};

exports.get_vmapi_origin_image = function (t) {
    var vmapiVmImgUuid;

    vasync.pipeline({funcs: [
        function getVmapiImg(ctx, next) {
            client.get('/vms?alias=vmapi&tag.smartdc_type=core',
                function onListVms(listVmsErr, req, res, vms) {
                    common.ifError(t, listVmsErr, 'list vms');
                    t.ok(vms, 'listing VMAPI core VMs should result in a ' +
                        'non-empty response');

                    vmapiVmImgUuid = vms[0].image_uuid;

                    next();
                });
        },

        function getOrigImg(ctx, next) {
            client.imgapi.get('/images/' + vmapiVmImgUuid,
                function onGetImage(getImgErr, req, res, image) {
                    common.ifError(t, getImgErr, 'get origin image');
                    t.ok(image, 'Listing VMAPI\'s VM\'s image should result ' +
                        'in a non-empty response');

                    VMAPI_ORIGIN_IMAGE_UUID = image.origin;

                    next();
                });
        }
    ]}, function onVmapiOriginImgRetrieved(err) {
        common.ifError(t, err, 'no pipeline err');
        t.done();
    });
};

exports.get_admin_fabric_network = function (t) {
    client.napi.get('/networks?owner_uuid=' + ADMIN_USER_UUID + '&fabric=true',
        function (err, req, res, networks) {
        // console.dir(networks);
        common.ifError(t, err, 'lookup admin fabric network');
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

exports.get_vm_payload_template = function (t) {
    VM_PAYLOAD = getVmPayloadTemplate();
    t.done();
};

exports.create_vm = function (t) {
    vasync.pipeline({arg: {}, funcs: [

        function createVm(ctx, next) {
            client.post({
                path: '/vms'
            }, VM_PAYLOAD, function onVmCreated(err, req, res, body) {
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
                VM_UUID = body.vm_uuid;
                mig.vms[VM_UUID] = body;
                console.log('# Vm uuid: ' + VM_UUID);

                next();
            });
        },

        function waitForProvisioningJob(ctx, next) {
            waitForValue('/jobs/' + ctx.jobUuid, 'execution', 'succeeded',
                { client: client, timeout: 10 * 60 },
                function onVmProvisioned(err) {
                    common.ifError(t, err, 'VM should provision successfully');
                    next();
                });
        },
        function getVmServer(ctx, next) {
            client.get('/vms/' + VM_UUID, function (err, req, res, body) {
                common.ifError(t, err, 'VM should appear in vmapi');
                next();
            });
        }
    ]}, function _provisionPipelineCb(err) {
        common.ifError(t, err, 'no provision pipeline err');
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
                path: format('/vms/%s?action=migrate&migration_action=begin',
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
                path: format('/vms/%s?action=migrate&migration_action=begin',
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

exports.migration_estimate = function test_migration_estimate(t) {
    if (!VM_UUID) {
        t.ok(false, 'Original VM was not created successfully');
        t.done();
        return;
    }

    client.post(
        {path: format('/vms/%s?action=migrate&migration_action=estimate',
                VM_UUID)},
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

exports.migration_begin = function test_migration_begin(t) {
    if (!VM_UUID) {
        t.ok(false, 'Original VM was not created successfully');
        t.done();
        return;
    }

    // XXX: Testing - tweak the uuid to allow on the same CN.
    // TODO: Check server list to see if this is needed (i.e. when there is
    // just one CN).
    var override_uuid = VM_UUID.slice(0, -6) + 'aaaaaa';
    var override_alias = getVmPayloadTemplate().alias + '-aaaaaa';

    // Trying to run a migration action when a migration has not started.
    client.post(
        { path:
            format('/vms/%s?action=migrate&migration_action=begin', VM_UUID) },
        { override_uuid: override_uuid, override_alias: override_alias },
        function onMigrateBeginCb(err, req, res, body) {
        common.ifError(t, err, 'no error when beginning the migration');
        if (!err) {
            t.ok(res, 'should get a restify response object');
            if (res) {
                t.equal(res.statusCode, 202,
                    format('err.statusCode === 202, got %s', res.statusCode));
                t.ok(res.body, 'should get a restify response body object');
            }
            if (body) {
                console.log(body);
                t.ok(body.job_uuid, 'got a job uuid in the begin response');

                // Watch for migration events.
                createMigrationWatcher(VM_UUID);

                var waitParams = {
                    client: client,
                    job_uuid: body.job_uuid,
                    timeout: 15 * 60
                };

                waitForJob(waitParams, function onMigrationJobCb(jerr, state,
                        job) {
                    common.ifError(t, jerr, 'begin should be successful');
                    if (!jerr) {
                        mig.started = (state === 'succeeded');
                        t.equal(state, 'succeeded',
                            'Migration begin job should succeed - ' +
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

    t.ok(mig.watcher, 'mig.watcher exists');
    if (!mig.watcher) {
        t.done();
        return;
    }

    var loopCount = 0;
    var timeoutSeconds = 2 * 60; // 2 minutes

    function waitForWatcherEnd() {
        loopCount += 1;
        if (!mig.watcher.ended) {
            if (loopCount > timeoutSeconds) {
                t.ok(false, 'Timed out waiting for the watcher to end');
                t.done();
                return;
            }
            setTimeout(waitForWatcherEnd, 1000);
            return;
        }

        // Check the events.
        t.ok(mig.watcher.events.length > 0, 'Should be events seen');

        var beginEvents = mig.watcher.events.filter(function _filtBegin(event) {
            return event.type === 'progress' && event.phase === 'begin';
        });
        t.ok(beginEvents.length > 0, 'Should have begin events');
        if (beginEvents.length > 0) {
            beginEvents.map(function (event) {
                t.ok(event.state === 'running' ||
                    event.state === 'successful',
                    'event state running or successful');
                t.ok(event.current_progress > 0, 'current_progress > 0');
                t.equal(event.total_progress, 100, 'total_progress === 100');
            });
        }

        var endEvent = mig.watcher.events.filter(function _filtEnd(event) {
            return event.type === 'end';
        }).slice(-1)[0];
        t.ok(endEvent, 'Should have an end event');
        if (endEvent) {
            t.equal(endEvent.phase, 'begin', 'end event phase is "begin"');
            t.equal(endEvent.state, 'paused', 'end event state is "paused"');
        }

        destroyMigrationWatcher();

        t.done();
    }

    waitForWatcherEnd();
};

exports.bad_migrate_cannot_begin_from_begin_phase = function (t) {
    // Invalid action according to the current migration phase.
    if (!mig.started) {
        t.ok(false, 'VM migration did not begin successfully');
        t.done();
        return;
    }

    client.post({
        path: format('/vms/%s?action=migrate&migration_action=begin',
                 VM_UUID)
    }, function onMigrateNoAction(err) {
        t.ok(err, 'expect an error when the migration already started');
        if (err) {
            t.equal(err.statusCode, 412,
                format('err.statusCode === 412, got %s', err.statusCode));
        }
        t.done();
    });
};

exports.bad_migrate_cannot_pause_from_paused_state = function (t) {
    // Invalid action according to the current migration state.
    if (!mig.started) {
        t.ok(false, 'VM migration did not begin successfully');
        t.done();
        return;
    }

    client.post({
        path: format('/vms/%s?action=migrate&migration_action=pause',
                 VM_UUID)
    }, function onMigrateNoAction(err) {
        t.ok(err, 'expect an error when the migration is already paused');
        if (err) {
            t.equal(err.statusCode, 412,
                format('err.statusCode === 412, got %s', err.statusCode));
        }
        t.done();
    });
};

exports.migration_list = function test_migration_list(t) {
    if (!mig.started) {
        t.ok(false, 'VM migration did not begin successfully');
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
            return entry.vm_uuid === VM_UUID;
        });
        t.ok(migrations.length >= 1, 'should be at least vm match');
        if (migrations.length === 0) {
            t.done();
            return;
        }

        var migration = migrations.slice(-1)[0];
        t.equal(migration.automatic, false, 'automatic should be false');
        t.equal(migration.phase, 'begin', 'phase should be "begin"');
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
        t.equal(lastProgress.phase, 'begin', 'phase should be "begin"');
        t.equal(lastProgress.state, 'successful', 'state is "successful"');

        t.done();
    });
};

exports.migration_sync = function test_migration_sync(t) {
    // Start the migration sync phase.
    if (!mig.started) {
        t.ok(false, 'VM migration did not begin successfully');
        t.done();
        return;
    }

    client.post({
        path: format('/vms/%s?action=migrate&migration_action=sync', VM_UUID)
    }, function onMigrateSyncCb(err, req, res, body) {
        common.ifError(t, err, 'no error expected when syncing the migration');
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

                // Watch for migration events.
                createMigrationWatcher(VM_UUID);

                var waitParams = {
                    client: client,
                    job_uuid: body.job_uuid,
                    timeout: 1 * 60 * 60 // 1 hour
                };

                waitForJob(waitParams, function onMigrationJobCb(jerr, state,
                        job) {
                    common.ifError(t, jerr,
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

    t.ok(mig.watcher, 'mig.watcher exists');
    if (!mig.watcher) {
        t.done();
        return;
    }

    var loopCount = 0;
    var timeoutSeconds = 5 * 60; // 5 minutes

    function waitForWatcherEnd() {
        loopCount += 1;
        if (!mig.watcher.ended) {
            if (loopCount > timeoutSeconds) {
                t.ok(false, 'Timed out waiting for the watcher to end');
                t.done();
                return;
            }
            setTimeout(waitForWatcherEnd, 1000);
            return;
        }

        // Check the events.
        t.ok(mig.watcher.events.length > 0, 'Should be events seen');

        var syncEvents = mig.watcher.events.filter(function _filtSync(event) {
            return event.type === 'progress' && event.phase === 'sync';
        });
        t.ok(syncEvents.length > 0, 'Should have sync events');
        if (syncEvents.length > 0) {
            var sawBandwidthEvent = false;
            syncEvents.map(function (event) {
                t.ok(event.state === 'running' ||
                    event.state === 'successful',
                    'event state running or successful');
                t.ok(event.current_progress, 'event has a current_progress');
                t.ok(event.total_progress, 'event has a total_progress');
                if (event.transfer_bytes_second) {
                    t.ok(event.eta_ms, 'event has a eta_ms');
                    sawBandwidthEvent = true;
                }
            });
            t.ok(sawBandwidthEvent, 'a bandwidth progress event was seen');
        }

        var endEvent = mig.watcher.events.filter(function _filtEnd(event) {
            return event.type === 'end';
        }).slice(-1)[0];
        t.ok(endEvent, 'Should have an end event');
        if (endEvent) {
            t.equal(endEvent.phase, 'sync', 'end event phase is "sync"');
            t.equal(endEvent.state, 'paused', 'end event state is "paused"');
        }

        destroyMigrationWatcher();

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
        common.ifError(t, err, 'no error expected when syncing the migration');
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
                    common.ifError(t, jerr, 'sync should be successful');
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
    // Start the migration switch phase.
    if (!mig.started) {
        t.ok(false, 'VM migration did not begin successfully');
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
        common.ifError(t, err, 'no error from migration switch call');
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

                // Watch for migration events.
                createMigrationWatcher(VM_UUID);

                var waitParams = {
                    client: client,
                    job_uuid: body.job_uuid,
                    timeout: 15 * 60 // 15 minutes
                };

                waitForJob(waitParams, function onMigrationJobCb(jerr, state,
                        job) {
                    common.ifError(t, jerr, 'switch should be successful');
                    if (!jerr) {
                        t.equal(state, 'succeeded',
                            'Migration switch job should succeed - ' +
                            (state === 'succeeded' ? 'ok' : getJobError(job)));
                    }
                    mig.switched = (state === 'succeeded');
                    mig.dni_vm_uuids.push(VM_UUID);
                    t.done();
                });
                return;
            }
        }
        t.done();
    });
};

exports.migration_switched_list = function test_migration_switched_list(t) {
    if (!mig.switched) {
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
            return entry.vm_uuid === VM_UUID;
        });
        t.ok(migrations.length >= 1, 'should be at least vm match');
        if (migrations.length === 0) {
            t.done();
            return;
        }

        var migration = migrations.slice(-1)[0];
        t.equal(migration.automatic, false, 'automatic should be false');
        t.equal(migration.phase, 'switch', 'phase should be "switch"');
        t.equal(migration.state, 'successful', 'state should be "successful"');
        t.equal(migration.vm_uuid, VM_UUID, 'vm_uuid should be the same');

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
            t.equal(entry.state, 'successful', 'progress state "successful"');

            if (phase === 'sync') {
                t.equal(entry.current_progress, entry.total_progress,
                    'current_progress should equal total_progress');
            } else {
                t.equal(entry.current_progress, 100, 'current_progress is 100');
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

exports.check_vmapi_state = function test_check_vmapi_state(t) {
    if (!VM_UUID) {
        t.ok(false, 'Original VM was not created successfully');
        t.done();
        return;
    }

    // The original vm should no longer be visible in vmapi. We use 'sync=true'
    // to ensure vmapi (via cnapi) will use the most up-to-date information.
    client.get({path: format('/vms/%s?sync=true', VM_UUID)},
        onGetOrigVm);

    function onGetOrigVm(err, req, res, vm) {
        t.ifError(err, 'should not get an error fetching original vm');
        if (res) {
            t.equal(res.statusCode, 200,
                format('err.statusCode === 200, got %s', res.statusCode));
        }
        t.ok(vm, 'should get a vm object');
        if (vm) {
            t.equal(vm.state, 'destroyed', 'original vm should be gone');
            mig.vms[vm.uuid] = vm;
            if (mig.dni_vm_uuids.indexOf(vm.uuid) === -1) {
                mig.dni_vm_uuids.push(vm.uuid);
            }
        }

        checkMigratedVm();
    }

    // The migrated vm *should* be visible through vmapi.
    function checkMigratedVm() {
        var migrated_uuid = VM_UUID.slice(0, -6) + 'aaaaaa';
        client.get({path: format('/vms/%s?sync=true', migrated_uuid)},
            onGetMigratedVm);
    }

    function onGetMigratedVm(err, req, res, vm) {
        common.ifError(t, err, 'should be no error fetching migrated vm');
        if (vm) {
            t.equal(vm.state, 'running', 'vm state should be "running"');
            mig.vms[vm.uuid] = vm;
        }
        t.done();
    }
};

exports.migration_full = function test_migration_full(t) {
    if (!mig.switched) {
        t.ok(false, 'VM migration did not switch successfully');
        t.done();
        return;
    }

    // TODO: Check server list to see if this is needed (i.e. when there is
    // just one CN).
    var switched_uuid = VM_UUID.slice(0, -6) + 'aaaaaa';
    var override_uuid = VM_UUID.slice(0, -6) + 'bbbbbb';
    var override_alias = getVmPayloadTemplate().alias + '-aaaaaa';

    // Trying to run a migration action when a migration has not started.
    var params = {
        action: 'migrate',
        migration_action: 'begin',
        migration_automatic: 'true',
        override_uuid: override_uuid,
        override_alias: override_alias
    };
    client.post({path: format('/vms/%s', switched_uuid)},
        params,
        onMigrateFullCb);

    function onMigrateFullCb(err, req, res, body) {
        common.ifError(t, err, 'no error when starting migration full');
        if (!err) {
            t.ok(res, 'should get a restify response object');
            if (res) {
                t.equal(res.statusCode, 202,
                    format('err.statusCode === 202, got %s', res.statusCode));
                t.ok(res.body, 'should get a restify response body object');
            }
            if (body) {
                console.log(body);
                t.ok(body.job_uuid, 'got a job uuid in the begin response');

                // Watch for migration events.
                createMigrationWatcher(switched_uuid);
            }
        }
        t.done();
    }
};

exports.check_full_watch_entries = function check_full_watch_entries(t) {

    t.ok(mig.watcher, 'mig.watcher exists');
    if (!mig.watcher) {
        t.done();
        return;
    }

    var loopCount = 0;
    var timeoutSeconds = 15 * 60; // 15 minutes

    function waitForWatcherEnd() {
        loopCount += 1;
        if (!mig.watcher.ended) {
            if (loopCount > timeoutSeconds) {
                t.ok(false, 'Timed out waiting for the watcher to end');
                t.done();
                return;
            }
            setTimeout(waitForWatcherEnd, 1000);
            return;
        }

        // Check the events.
        t.ok(mig.watcher.events.length > 0, 'Should be events seen');

        var beginEvents = mig.watcher.events.filter(function _filtBegin(event) {
            return event.type === 'progress' && event.phase === 'begin';
        });
        t.ok(beginEvents.length > 0, 'Should have begin events');
        if (beginEvents.length > 0) {
            beginEvents.map(function (event) {
                t.ok(event.state === 'running' ||
                    event.state === 'successful',
                    'event state running or successful');
                t.ok(event.current_progress > 0, 'current_progress > 0');
                t.equal(event.total_progress, 100, 'total_progress === 100');
            });
        }

        var syncEvents = mig.watcher.events.filter(function _filtSync(event) {
            return event.type === 'progress' && event.phase === 'sync';
        });
        t.ok(syncEvents.length > 0, 'Should have sync events');
        if (syncEvents.length > 0) {
            // There should be at least three distinct sync phases.
            var syncStartEvents = syncEvents.filter(function _filSync(event) {
                return event.message === 'syncing data';
            });
            t.ok(syncStartEvents.length >= 3, 'Should have at least 3 ' +
                'different sync events');
            var sawBandwidthEvent = false;
            syncEvents.map(function (event) {
                // All sync events should have state 'running'
                t.ok(event.state === 'running', 'event state is "running"');
                t.ok(event.current_progress, 'event has a current_progress');
                t.ok(event.total_progress, 'event has a total_progress');
                if (event.transfer_bytes_second) {
                    t.ok(event.eta_ms, 'event has a eta_ms');
                    sawBandwidthEvent = true;
                }
            });
            t.ok(sawBandwidthEvent, 'a bandwidth progress event was seen');
        }

        var endEvent = mig.watcher.events.filter(function _filtEnd(event) {
            return event.type === 'end';
        }).slice(-1)[0];
        t.ok(endEvent, 'Should have an end event');
        if (endEvent) {
            t.equal(endEvent.phase, 'switch', 'end event phase is "switch"');
            t.equal(endEvent.state, 'successful',
                'end event state is "successful"');
            if (endEvent.state === 'successful') {
                mig.dni_vm_uuids.push(mig.watcher.vm_uuid);
            }
        }

        destroyMigrationWatcher();

        t.done();
    }

    waitForWatcherEnd();
};

exports.check_vmapi_state_2 = function test_check_vmapi_state_2(t) {
    if (mig.dni_vm_uuids.length < 2) {
        t.ok(false, 'Vms were not migrated successfully');
        t.done();
        return;
    }

    // The original vm should no longer be visible in vmapi. We use 'sync=true'
    // to ensure vmapi (via cnapi) will use the most up-to-date information.
    client.get({path: format('/vms/%s?sync=true',
        mig.dni_vm_uuids.slice(-1)[0])},
        onGetOrigVm);

    function onGetOrigVm(err, req, res, vm) {
        common.ifError(t, err, 'should not get an error fetching original vm');
        if (res) {
            t.equal(res.statusCode, 200,
                format('err.statusCode === 200, got %s', res.statusCode));
        }
        t.ok(vm, 'should get a vm object');
        if (vm) {
            t.equal(vm.state, 'destroyed', 'original vm should be gone');
            mig.vms[vm.uuid] = vm;
            if (mig.dni_vm_uuids.indexOf(vm.uuid) === -1) {
                mig.dni_vm_uuids.push(vm.uuid);
            }
        }

        checkMigratedVm();
    }

    // The migrated vm *should* be visible through vmapi.
    function checkMigratedVm() {
        var migrated_uuid = VM_UUID.slice(0, -6) + 'bbbbbb';
        client.get({path: format('/vms/%s?sync=true', migrated_uuid)},
            onGetMigratedVm);
    }

    function onGetMigratedVm(err, req, res, vm) {
        common.ifError(t, err, 'should be no error fetching migrated vm');
        if (vm) {
            t.equal(vm.state, 'running', 'vm state should be "running"');
            mig.vms[vm.uuid] = vm;
        }
        t.done();
    }
};

exports.cleanup = function test_cleanup(t) {
    if (!VM_UUID) {
        t.ok(false, 'VM_UUID not found, cannot delete VM');
        t.done();
        return;
    }

    vasync.forEachParallel({
        inputs: Object.keys(mig.vms),
        func: deleteOneVm
    }, function onDeleteVmsCb(err) {
        common.ifError(t, err, 'should be no error deleting vms');
        t.done();
    });

    function deleteOneVm(vm_uuid, callback) {
        if (mig.dni_vm_uuids.indexOf(vm_uuid) >= 0) {
            deleteDniVm(vm_uuid, callback);
            return;
        }

        client.del({path: format('/vms/%s', vm_uuid)}, callback);
    }

    // To delete a hidden (DNI) vm, we execute a 'vmadm delete' on the server
    // in question.
    function deleteDniVm(vm_uuid, callback) {
        t.ok(mig.vms[vm_uuid], 'mig.vms entry exists for vm ' + vm_uuid);
        if (!mig.vms[vm_uuid]) {
            callback(new Error('No mig.vms entry for ' + vm_uuid));
            return;
        }
        var server_uuid = mig.vms[vm_uuid].server_uuid;
        var params = {
            script: format('#!/bin/bash\nvmadm delete %s', vm_uuid),
            server_uuid: server_uuid
        };
        client.cnapi.post({path: format('/servers/%s/execute', server_uuid)},
            params,
            onServerExecuteCb);

        function onServerExecuteCb(err) {
            common.ifError(t, err, 'error running vmadm delete on server');
            callback(err);
        }
    }
};
