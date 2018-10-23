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

var util = require('util');

var assert = require('assert-plus');
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

var client;
var mig = {};


/* Helper functions */

function getVmPayloadTemplate() {
    return {
        alias: 'vmapitest-migrate-' + testUuid.generateShortUuid(),
        owner_uuid: ADMIN_USER_UUID,
        image_uuid: VMAPI_ORIGIN_IMAGE_UUID,
        server_uuid: SERVER.uuid,
        networks: [ { uuid: ADMIN_FABRIC_NETWORK.uuid } ],
        brand: 'joyent-minimal',
        billing_id: '00000000-0000-0000-0000-000000000000',
        ram: 1024,
        quota: 10,
        cpu_cap: 100
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

exports.create_vm = function (t) {
    if (process.env.MIGRATION_VM_UUID) {
        VM_UUID = process.env.MIGRATION_VM_UUID;
        t.done();
        return;
    }

    var vmPayload = getVmPayloadTemplate();

    vasync.pipeline({arg: {}, funcs: [

        function createVm(ctx, next) {
            client.post({
                path: '/vms'
            }, vmPayload, function onVmCreated(err, req, res, body) {
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
    // Trying to run a migration action when there a migration has not started.
    client.post({
        path: format('/vms/%s?action=migrate&migration_action=start', VM_UUID)
    }, function onMigrateStartCb(err, req, res, body) {
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
                console.log('{ req_id: ' + res.headers['x-request-id'] + ' }');
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
        t.ok(false, 'Not performing switch');
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
        path: '/vms/' + VM_UUID
    }, function onVmDelete(err) {
        t.ifError(err, 'Deleting VM ' + VM_UUID + ' should succeed');

        if (err) {
            t.done();
            return;
        }

        waitForValue('/vms/' + VM_UUID, 'state', 'destroyed', {
            client: client
        }, function onVmDeleted(vmDelErr) {
            t.ifError(vmDelErr, 'VM should have been deleted successfully');
            t.done();
        });
    });
};
