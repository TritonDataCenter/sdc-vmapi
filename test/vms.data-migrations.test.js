/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var jsprim = require('jsprim');
var libuuid = require('libuuid');
var once = require('once');
var path = require('path');
var restify = require('restify');
var util = require('util');
var vasync = require('vasync');
var VError = require('verror');
var VMAPI = require('sdc-clients').VMAPI;

var changefeedUtils = require('../lib/changefeed');
var common = require('./common');
var DataMigrationsController = require('../lib/data-migrations/controller');
var dataMigrationsLoader = require('../lib/data-migrations/loader');
var morayInit = require('../lib/moray/moray-init');
var testMoray = require('./lib/moray.js');
var VmapiApp = require('../lib/vmapi');

var MOCKED_WFAPI_CLIENT = {
    connected: true,
    connect: function mockedWfapiConnect(callback) {
        callback();
    }
};

var VMS_BUCKET_NAME = 'test_vmapi_vms_data_migrations';
var SERVER_VMS_BUCKET_NAME = 'test_vmapi_server_vms_data_migrations';
var ROLE_TAGS_BUCKET_NAME = 'test_vmapi_vm_role_tags_data_migrations';

var VMS_BUCKET_CONFIG = {
    name: VMS_BUCKET_NAME,
    schema: {
        index: {
            foo: { type: 'string' },
            bar: { type: 'string' },
            data_version: { type: 'number' }
        }
    }
};

var SERVER_VMS_MORAY_BUCKET_CONFIG = {
    name: SERVER_VMS_BUCKET_NAME,
    schema: {}
};

var ROLE_TAGS_MORAY_BUCKET_CONFIG = {
    name: ROLE_TAGS_BUCKET_NAME,
    schema: {
    }
};

var TEST_BUCKETS_CONFIG = {
    vms: VMS_BUCKET_CONFIG,
    server_vms: SERVER_VMS_MORAY_BUCKET_CONFIG,
    vm_role_tags: ROLE_TAGS_MORAY_BUCKET_CONFIG
};

/*
 * The number of test objects is chosen so that it's larger than the default
 * page for Moray requests (which is currently 1000). 2001 objects means that at
 * least 3 Moray requests are necessary to read all records from the test moray
 * buckets, and so that we go through 3 iterations of the read/transform/write
 * cycle involved in migrating records.
 */
var NUM_TEST_OBJECTS = 2001;

function findAllObjects(morayClient, bucketName, filter, callback) {
    assert.object(morayClient, 'morayClient');
    assert.string(bucketName, 'bucketName');
    assert.func(callback, 'callback');

    var callbackOnce = once(callback);
    var allRecords = [];

    var findAllObjectsReq = morayClient.findObjects(bucketName, filter);

    findAllObjectsReq.once('error', function onError(findErr) {
        cleanup();
        callbackOnce(findErr);
    });

    findAllObjectsReq.on('record', function onRecord(record) {
        allRecords.push(record);
    });

    findAllObjectsReq.once('end', function onGotAllRecords() {
        cleanup();
        callbackOnce(null, allRecords);
    });

    function cleanup() {
        findAllObjectsReq.removeAllListeners('error');
        findAllObjectsReq.removeAllListeners('record');
        findAllObjectsReq.removeAllListeners('end');
    }
}

function writeObjects(morayClient, bucketName, valueTemplate, nbObjects,
    callback) {
    assert.object(morayClient, 'morayClient');
    assert.string(bucketName, 'bucketName');
    assert.object(valueTemplate, 'valueTemplate');
    assert.number(nbObjects, 'nbObjects');
    assert.func(callback, 'callback');

    var i;

    var objectKeys = [];
    for (i = 0; i < nbObjects; ++i) {
        objectKeys.push(libuuid.create());
    }

    vasync.forEachParallel({
        func: function writeObject(objectUuid, done) {
            var newObjectValue = jsprim.deepCopy(valueTemplate);
            newObjectValue.uuid = objectUuid;
            morayClient.putObject(bucketName, objectUuid, newObjectValue, done);
        },
        inputs: objectKeys
    }, callback);
}

exports.data_migrations_invalid_filenames = function (t) {
    var dataMigrationsLoaderLogger = bunyan.createLogger({
        name: 'data-migrations-loader',
        level: 'debug',
        serializers: restify.bunyan.serializers
    });

    dataMigrationsLoader.loadMigrations({
        log: dataMigrationsLoaderLogger,
        migrationsRootPath: path.resolve(__dirname, 'fixtures',
            'data-migrations-invalid-filenames')
    }, function onMigrationsLoaded(loadMigrationsErr, migrations) {
        var expectedErrorName = 'InvalidDataMigrationFileNamesError';

        t.ok(loadMigrationsErr,
            'loading migrations with invalid filenames should error');

        if (loadMigrationsErr) {
            t.ok(VError.hasCauseWithName(loadMigrationsErr, expectedErrorName),
                'error should have a cause of ' + expectedErrorName);
        }

        t.done();
    });
};

exports.data_migrations = function (t) {
    var context = {};
    var TRANSIENT_ERROR_MSG = 'Mocked transient error';

    vasync.pipeline({arg: context, funcs: [
        function cleanup(ctx, next) {
            testMoray.cleanupLeftoverBuckets([
                VMS_BUCKET_NAME,
                SERVER_VMS_BUCKET_NAME,
                ROLE_TAGS_BUCKET_NAME
            ],
            function onCleanupLeftoverBuckets(cleanupErr) {
                t.ok(!cleanupErr,
                    'cleaning up leftover buckets should be successful');
                next(cleanupErr);
            });
        },
        function setupMorayBuckets(ctx, next) {
            var morayBucketsInitializer;
            var morayClient;
            var moraySetup = morayInit.startMorayInit({
                morayConfig: common.config.moray,
                morayBucketsConfig: TEST_BUCKETS_CONFIG,
                changefeedPublisher: changefeedUtils.createNoopCfPublisher()
            });
            var nextOnce = once(next);

            ctx.moray = moraySetup.moray;
            ctx.morayBucketsInitializer = morayBucketsInitializer =
                moraySetup.morayBucketsInitializer;
            ctx.morayClient = morayClient = moraySetup.morayClient;

            function cleanUp() {
                morayBucketsInitializer.removeAllListeners('error');
                morayBucketsInitializer.removeAllListeners('done');
            }

            morayBucketsInitializer.on('done', function onMorayBucketsInit() {
                t.ok(true,
                    'original moray buckets setup should be ' +
                        'successful');

                cleanUp();
                nextOnce();
            });

            morayBucketsInitializer.on('error',
                function onMorayBucketsInitError(morayBucketsInitErr) {
                    t.ok(!morayBucketsInitErr,
                        'original moray buckets initialization should ' +
                            'not error');

                    cleanUp();
                    nextOnce(morayBucketsInitErr);
                });
        },
        function writeTestObjects(ctx, next) {
            assert.object(ctx.morayClient, 'ctx.morayClient');

            writeObjects(ctx.morayClient, VMS_BUCKET_NAME, {
                foo: 'foo'
            }, NUM_TEST_OBJECTS, function onTestObjectsWritten(writeErr) {
                t.ok(!writeErr, 'writing test objects should not error, got: ' +
                    util.inspect(writeErr));
                next(writeErr);
            });
        },
        function loadDataMigrations(ctx, next) {
            var dataMigrationsLoaderLogger = bunyan.createLogger({
                name: 'data-migrations-loader',
                level: 'info',
                serializers: restify.bunyan.serializers
            });

            dataMigrationsLoader.loadMigrations({
                log: dataMigrationsLoaderLogger,
                migrationsRootPath: path.resolve(__dirname, 'fixtures',
                    'data-migrations-valid')
            }, function onMigrationsLoaded(loadMigrationsErr, migrations) {
                ctx.migrations = migrations;
                next(loadMigrationsErr);
            });
        },
        function createMigrationsController(ctx, next) {
            assert.object(ctx.migrations, 'ctx.migrations');
            assert.object(ctx.moray, 'ctx.moray');

            ctx.dataMigrationsCtrl = new DataMigrationsController({
                log: bunyan.createLogger({
                    name: 'data-migratons-controller',
                    level: 'info',
                    serializers: restify.bunyan.serializers
                }),
                migrations: ctx.migrations,
                moray: ctx.moray
            });

            next();
        },
        function startVmapiService(ctx, next) {
            ctx.vmapiApp = new VmapiApp({
                apiClients: {
                    wfapi: MOCKED_WFAPI_CLIENT
                },
                changefeedPublisher: changefeedUtils.createNoopCfPublisher(),
                dataMigrationsCtrl: ctx.dataMigrationsCtrl,
                morayBucketsInitializer: ctx.morayBucketsInitializer,
                moray: ctx.moray
            });

            /*
             * port: 0 makes the ctx.vmapiApp HTTP server listen on a random
             * port.
             */
            ctx.vmapiApp.listen({port: 0}, function onVmapiListening() {
                var vmapiServerAddress = ctx.vmapiApp.server.address();
                var vmapiServerUrl = 'http://' + vmapiServerAddress.address +
                    ':' + vmapiServerAddress.port;

                ctx.vmapiClient = new VMAPI({
                    url: vmapiServerUrl
                });

                next();
            });
        },
        function checkDataMigrationsNoneStarted(ctx, next) {
            assert.object(ctx.vmapiClient, 'ctx.vmapiClient');

            ctx.vmapiClient.ping(function onVmapiPing(pingErr, obj, req, res) {
                t.ok(!pingErr, 'pinging VMAPI when data migrations have not ' +
                    'started yet should not error');
                t.ok(obj, 'pinging VMAPI when data migrations have not ' +
                    'started should return a non-empty response');
                if (obj) {
                    t.ok(obj.dataMigrations &&
                        obj.dataMigrations.latestCompletedMigrations,
                        'ping response should have a ' +
                            'dataMigrations.latestCompletedMigrations ' +
                            'property');
                }
                next();
            });
        },
        function injectTransientError(ctx, next) {
            ctx.originalPutBatch = ctx.moray.putBatch;
            ctx.moray.putBatch =
                function mockedPutBatch(modelName, records, callback) {
                    assert.string(modelName, 'modelName');
                    assert.arrayOfObject(records, 'records');
                    assert.func(callback, 'callback');

                    callback(new Error(TRANSIENT_ERROR_MSG));
                };
            next();
        },
        function startMigrations(ctx, next) {
            ctx.dataMigrationsCtrl.start();

            ctx.dataMigrationsCtrl.once('done',
                function onDataMigrationsDone() {
                    t.ok(false, 'data migrations should not complete when ' +
                        'transient error injected');
                });

            ctx.dataMigrationsCtrl.once('error',
                function onDataMigrationsError(dataMigrationErr) {
                    t.ok(false, 'data migrations should not error when ' +
                        'transient error injected');
                });

                next();
        },
        function checkDataMigrationsTransientError(ctx, next) {
            var MAX_NUM_TRIES = 20;
            var NUM_TRIES = 0;
            var RETRY_DELAY_IN_MS = 1000;

            assert.object(ctx.vmapiClient, 'ctx.vmapiClient');

            function doCheckMigrationsStatus() {
                ++NUM_TRIES;

                ctx.vmapiClient.ping(function onPing(pingErr, obj, req, res) {
                    var foundExpectedErrMsg;
                    var latestVmsMigrationsErr;

                    console.log('pingErr:', pingErr);
                    console.log('obj:', obj);

                    t.ok(!pingErr, 'pinging VMAPI when data migrations fail ' +
                        'should return a non-error status, got: ' + pingErr);
                    t.ok(obj, 'pinging VMAPI when data migrations fail ' +
                        'should return a non-empty response, got: ' + obj);
                    if (obj.dataMigrations &&
                        obj.dataMigrations.latestErrors &&
                        obj.dataMigrations.latestErrors.vms) {
                        latestVmsMigrationsErr =
                            obj.dataMigrations.latestErrors.vms;
                        foundExpectedErrMsg =
                            latestVmsMigrationsErr.indexOf(TRANSIENT_ERROR_MSG)
                                !== -1;
                        t.ok(foundExpectedErrMsg,
                            'data migrations latest error should include ' +
                                TRANSIENT_ERROR_MSG + ', got: ' +
                                obj.dataMigrations.latestErrors.vms);
                        next();
                    } else {
                        if (NUM_TRIES >= MAX_NUM_TRIES) {
                            t.ok(false, 'max number of tries exceeded');
                            next();
                        } else {
                            setTimeout(doCheckMigrationsStatus,
                                RETRY_DELAY_IN_MS);
                        }
                    }
                });
            }

            doCheckMigrationsStatus();
        },
        function checkInternalMetadataSearchError(ctx, next) {
            ctx.vmapiClient.listVms({'internal_metadata.foo': 'bar'},
                function onListVms(listVmsErr, obj, req, res) {
                    var expectedErrorName = 'DataVersionError';

                    t.ok(listVmsErr, 'searching on internal_metadata when ' +
                        'the corresponding data migration has not completed ' +
                        'should error');
                    if (listVmsErr) {
                        t.equal(listVmsErr.name, expectedErrorName,
                            'Error name should be: ' + expectedErrorName +
                                ', got: ' + listVmsErr.name);
                    }

                    next();
                });
        },
        function removeTransientError(ctx, next) {
            ctx.dataMigrationsCtrl.removeAllListeners('done');
            ctx.dataMigrationsCtrl.removeAllListeners('error');

            ctx.moray.putBatch = ctx.originalPutBatch;

            ctx.dataMigrationsCtrl.once('done',
                function onDataMigrationsDone() {
                    t.ok(true,
                        'data migration should eventually complete ' +
                            'successfully');
                    next();
                });

            ctx.dataMigrationsCtrl.once('error',
                function onDataMigrationsError(dataMigrationErr) {
                    t.ok(false, 'data migrations should not error, got: ',
                        util.inspect(dataMigrationErr));
                    next(dataMigrationErr);
                });
        },
        function readTestObjects(ctx, next) {
            assert.object(ctx.morayClient, 'ctx.morayClient');

            findAllObjects(ctx.morayClient, VMS_BUCKET_NAME, '(foo=*)',
                function onFindAllObjects(findErr, objects) {
                    var nonMigratedObjects;

                    t.ok(!findErr,
                        'reading all objects back should not error, got: ' +
                            util.inspect(findErr));
                    t.ok(objects,
                        'reading all objects should not return empty response');

                    if (objects) {
                        nonMigratedObjects =
                            objects.filter(function checkObjects(object) {
                                return object.value.bar !== 'foo';
                            });
                        t.equal(nonMigratedObjects.length, 0,
                            'data migrations should have migrated all objects' +
                                ', got the following non-migrated objects: ' +
                                nonMigratedObjects.join(', '));
                    }

                    next(findErr);
                });
        },
        function checkDataMigrationsDone(ctx, next) {
            var latestExpectedCompletedVmsMigration = 1;

            assert.object(ctx.vmapiClient, 'ctx.vmapiClient');

            ctx.vmapiClient.ping(function onVmapiPing(pingErr, obj, req, res) {
                t.ok(!pingErr, 'ping VMAPI when data migrations suceeded ' +
                    'should not error, got: ' + pingErr);
                t.ok(obj, 'pinging VMAPI when data migrations succeeded ' +
                    'should return a non-empty response');

                if (obj &&
                    obj.dataMigrations &&
                    obj.dataMigrations.latestCompletedMigrations) {
                    t.equal(obj.dataMigrations.latestCompletedMigrations.vms,
                        latestExpectedCompletedVmsMigration,
                        'latest completed data migration for vms model ' +
                            'should be at version ' +
                            latestExpectedCompletedVmsMigration);
                } else {
                    t.ok(false, 'pinging VMAPI when data migrations ' +
                        'succeeded should return an object with latest ' +
                        'completed migrations, got: ' + util.inspect(obj));
                }

                next();
            });
        }
    ]}, function allMigrationsDone(allMigrationsErr) {
        t.ok(!allMigrationsErr, 'data migrations test should not error');

        context.morayClient.close();
        context.vmapiClient.close();
        context.vmapiApp.close();

        t.done();
    });
};

exports.data_migrations_non_transient_error = function (t) {
    var context = {};

    vasync.pipeline({arg: context, funcs: [
        function cleanup(ctx, next) {
            testMoray.cleanupLeftoverBuckets([
                VMS_BUCKET_NAME,
                SERVER_VMS_BUCKET_NAME,
                ROLE_TAGS_BUCKET_NAME
            ],
            function onCleanupLeftoverBuckets(cleanupErr) {
                t.ok(!cleanupErr,
                    'cleaning up leftover buckets should be successful');
                next(cleanupErr);
            });
        },
        function setupMorayBuckets(ctx, next) {
            var morayBucketsInitializer;
            var morayClient;
            var moraySetup = morayInit.startMorayInit({
                morayConfig: common.config.moray,
                morayBucketsConfig: TEST_BUCKETS_CONFIG,
                changefeedPublisher: changefeedUtils.createNoopCfPublisher()
            });
            var nextOnce = once(next);

            ctx.moray = moraySetup.moray;
            ctx.morayBucketsInitializer = morayBucketsInitializer =
                moraySetup.morayBucketsInitializer;
            ctx.morayClient = morayClient = moraySetup.morayClient;

            function cleanUp() {
                morayBucketsInitializer.removeAllListeners('error');
                morayBucketsInitializer.removeAllListeners('done');
            }

            morayBucketsInitializer.on('done', function onMorayBucketsInit() {
                t.ok(true,
                    'original moray buckets setup should be ' +
                        'successful');

                cleanUp();
                nextOnce();
            });

            morayBucketsInitializer.on('error',
                function onMorayBucketsInitError(morayBucketsInitErr) {
                    t.ok(!morayBucketsInitErr,
                        'original moray buckets initialization should ' +
                            'not error');

                    cleanUp();
                    nextOnce(morayBucketsInitErr);
                });
        },
        function writeTestObjects(ctx, next) {
            assert.object(ctx.morayClient, 'ctx.morayClient');

            writeObjects(ctx.morayClient, VMS_BUCKET_NAME, {
                foo: 'foo'
            }, NUM_TEST_OBJECTS, function onTestObjectsWritten(writeErr) {
                t.ok(!writeErr, 'writing test objects should not error, got: ' +
                    util.inspect(writeErr));
                next(writeErr);
            });
        },
        function loadDataMigrations(ctx, next) {
            var dataMigrationsLoaderLogger = bunyan.createLogger({
                name: 'data-migrations-loader',
                level: 'info',
                serializers: restify.bunyan.serializers
            });

            dataMigrationsLoader.loadMigrations({
                log: dataMigrationsLoaderLogger,
                migrationsRootPath: path.resolve(__dirname, 'fixtures',
                    'data-migrations-valid')
            }, function onMigrationsLoaded(loadMigrationsErr, migrations) {
                ctx.migrations = migrations;
                next(loadMigrationsErr);
            });
        },
        function injectNonTransientError(ctx, next) {
            ctx.originalPutBatch = ctx.moray.putBatch;
            ctx.moray.putBatch =
                function mockedPutBatch(modelName, records, callback) {
                    assert.string(modelName, 'modelName');
                    assert.arrayOfObject(records, 'records');
                    assert.func(callback, 'callback');

                    callback(new VError({
                        name: 'BucketNotFoundError'
                    }, 'non-transient error'));
                };
            next();
        },
        function startMigrations(ctx, next) {
            assert.object(ctx.migrations, 'ctx.migrations');
            assert.object(ctx.moray, 'ctx.moray');

            ctx.dataMigrationsCtrl = new DataMigrationsController({
                log: bunyan.createLogger({
                    name: 'data-migratons-controller',
                    level: 'info',
                    serializers: restify.bunyan.serializers
                }),
                migrations: ctx.migrations,
                moray: ctx.moray
            });

            ctx.dataMigrationsCtrl.start();

            ctx.dataMigrationsCtrl.once('done',
                function onDataMigrationsDone() {
                    t.ok(false, 'data migration should not complete when ' +
                        'non-transient error injected');
                });

            ctx.dataMigrationsCtrl.once('error',
                function onDataMigrationsError(dataMigrationErr) {
                    t.ok(true, 'data migrations should error when ' +
                        'non-transient error injected, got: ' +
                        dataMigrationErr.toString());
                    next();
                });
        }
    ]}, function allMigrationsDone(allMigrationsErr) {
        t.equal(allMigrationsErr, undefined,
                'data migrations test should not error');
        context.morayClient.close();
        t.done();
    });
};
