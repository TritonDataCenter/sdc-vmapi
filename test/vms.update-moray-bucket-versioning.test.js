/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');
var jsprim = require('jsprim');
var libuuid = require('libuuid');
var once = require('once');
var path = require('path');
var restify = require('restify');
var util = require('util');
var vasync = require('vasync');
var VMAPI = require('sdc-clients').VMAPI;

var changefeedUtils = require('../lib/changefeed');
var common = require('./common');
var morayInit = require('../lib/moray/moray-init');
var NoopDataMigrationsController =
    require('../lib/data-migrations/noop-controller');
var testMoray = require('./lib/moray.js');
var VmapiApp = require('../lib/vmapi');

var MOCKED_WFAPI_CLIENT = {
    connected: true,
    connect: function mockedWfapiConnect(callback) {
        callback();
    }
};

var VMS_BUCKET_NAME = 'test_vmapi_vms_versioning';
var SERVER_VMS_BUCKET_NAME = 'test_vmapi_server_vms_versioning';
var ROLE_TAGS_BUCKET_NAME = 'test_vmapi_vm_role_tags_versioning';

/*
 * Initial buckets configuration, version 0.
 */
var VMS_BUCKET_CONFIG_V0 = {
    name: VMS_BUCKET_NAME,
    schema: {
        index: {
            uuid: { type: 'string', unique: true }
        }
    }
};

var SERVER_VMS_MORAY_BUCKET_CONFIG_V0 = {
    name: SERVER_VMS_BUCKET_NAME,
    schema: {}
};

var ROLE_TAGS_MORAY_BUCKET_CONFIG_V0 = {
    name: ROLE_TAGS_BUCKET_NAME,
    schema: {
    }
};

/*
 * Buckets configuration at version 1: an index is added on the property named
 * "indexed_property". The upgrade from version 0 to version 1 is valid.
 */
var VMS_BUCKET_CONFIG_V1 = {
    name: VMS_BUCKET_NAME,
    schema: {
        index: {
            uuid: { type: 'string', unique: true },
            indexed_property: { type: 'string' }
        },
        options: {
            version: 1
        }
    }
};

var SERVER_VMS_MORAY_BUCKET_CONFIG_V1 = {
    name: SERVER_VMS_BUCKET_NAME,
    schema: {}
};

var ROLE_TAGS_MORAY_BUCKET_CONFIG_V1 = {
    name: ROLE_TAGS_BUCKET_NAME,
    schema: {
        index: {
            role_tags: { type: '[string]' }
        }
    }
};

/*
 * Buckets configuration at version 2: an index is added on the property named
 * "another_indexed_property". The upgrade from version 1 to version 2 is valid.
 */
var VMS_BUCKET_CONFIG_V2 = {
    name: VMS_BUCKET_NAME,
    schema: {
        index: {
            uuid: { type: 'string', unique: true },
            indexed_property: { type: 'string' },
            another_indexed_property: { type: 'string' }
        },
        options: {
            version: 2
        }
    }
};

var SERVER_VMS_MORAY_BUCKET_CONFIG_V2 = {
    name: SERVER_VMS_BUCKET_NAME,
    schema: {}
};

var ROLE_TAGS_MORAY_BUCKET_CONFIG_V2 = {
    name: ROLE_TAGS_BUCKET_NAME,
    schema: {
        index: {
            role_tags: { type: '[string]' }
        }
    }
};

var testBucketsConfigV0 = {
    vms: VMS_BUCKET_CONFIG_V0,
    server_vms: SERVER_VMS_MORAY_BUCKET_CONFIG_V0,
    vm_role_tags: ROLE_TAGS_MORAY_BUCKET_CONFIG_V0
};

var testBucketsConfigV1 = {
    vms: VMS_BUCKET_CONFIG_V1,
    server_vms: SERVER_VMS_MORAY_BUCKET_CONFIG_V1,
    vm_role_tags: ROLE_TAGS_MORAY_BUCKET_CONFIG_V1
};

var testBucketsConfigV2 = {
    vms: VMS_BUCKET_CONFIG_V2,
    server_vms: SERVER_VMS_MORAY_BUCKET_CONFIG_V2,
    vm_role_tags: ROLE_TAGS_MORAY_BUCKET_CONFIG_V2
};

var NB_TEST_OBJECTS = 200;

function getAllObjects(morayClient, bucketName, callback) {
    assert.object(morayClient, 'morayClient');
    assert.string(bucketName, 'bucketName');
    assert.func(callback, 'callback');

    var callbackOnce = once(callback);
    var allRecords = [];

    var findAllObjectsReq = morayClient.sql('select _rver from ' +
        VMS_BUCKET_NAME);

    findAllObjectsReq.once('error', function onSqlError(sqlErr) {
        cleanup();
        callbackOnce(sqlErr);
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

function testMigrationToBucketsConfig(bucketsConfig, options, t, callback) {
    assert.object(bucketsConfig, 'bucketsConfig');
    assert.object(options, 'options');
    assert.arrayOfObject(options.expectedResults, 'options.expectedResults');
    assert.object(t, 't');
    assert.func(callback, 'callback');

    var morayBucketsInitializer;
    var morayClient;
    var storage;

    var vmapiApp;

    vasync.pipeline({funcs: [
        function initMorayStorage(arg, next) {
            var moraySetup = morayInit.startMorayInit({
                morayConfig: common.config.moray,
                morayBucketsConfig: bucketsConfig,
                changefeedPublisher: changefeedUtils.createNoopCfPublisher()
            });

            morayBucketsInitializer = moraySetup.morayBucketsInitializer;
            morayClient = moraySetup.morayClient;
            storage = moraySetup.moray;

            morayBucketsInitializer.on('done',
                function onMorayBucketsInit() {
                    t.ok(true,
                        'moray initialization should be successfull');
                    next();
                });
        },
        /*
         * After a moray bucket is migrated to a version that adds a new index,
         * it is important to make sure that it's safe to use for both read and
         * write operations. For instance, search filters will not work as
         * expected when a bucket is being reindexed and putobject operations
         * will also not use the updated bucket schema if they write to a row
         * that hasn't been reindexed yet, leading to data corruption.
         *
         * To check that a bucket has been properly reindexed after an update,
         * we need to check that:
         *
         * 1. The migrated bucket is at the expected version.
         *
         * 2. The 'reindex_active' column of the row representing the migrated
         * bucket in the 'buckets_config'' table has a value representing an
         * empty object.
         *
         * 3. All rows in the table storing the migrated bucket's data' have the
         * expected version number.
         */
        function checkBucketsAtExpectedVersion(arg, next) {
            var expectedResults = options.expectedResults;

            vasync.forEachPipeline({
                func: function checkBucketVersion(expectedResult, done) {
                    assert.object(expectedResult, 'expectedResult');

                    var bucketName = expectedResult.bucketName;
                    assert.string(bucketName, 'bucketName');

                    var expectedVersion = expectedResult.version;
                    assert.number(expectedVersion, 'expectedVersion');

                    morayClient.getBucket(bucketName,
                        function onGetBucket(getBucketErr, bucket) {
                            t.equal(bucket.options.version, expectedVersion,
                                'Bucket with name ' + bucketName +
                                    ' should be at version ' + expectedVersion);

                            done();
                        });
                },
                inputs: expectedResults
            }, next);
        },
        function checkObjectsAtExpectedVersion(arg, next) {
            var expectedResults = options.expectedResults;

            vasync.forEachPipeline({
                func: function checkObjectsVersion(expectedResult, done) {
                    assert.object(expectedResult, 'expectedResult');

                    var bucketName = expectedResult.bucketName;
                    assert.string(bucketName, 'bucketName');

                    var expectedVersion = expectedResult.version;
                    assert.number(expectedVersion, 'expectedVersion');

                    getAllObjects(morayClient, bucketName,
                        function onGetAllObjects(versionCheckErr, allRecords) {
                            var allRecordsAtExpectedVersion = false;

                            t.strictEqual(allRecords.length, NB_TEST_OBJECTS,
                                NB_TEST_OBJECTS + ' records must have been ' +
                                    'checked');

                            allRecordsAtExpectedVersion =
                                allRecords.every(function checkVersion(record) {
                                    assert.object(record, 'record');

                                    return record._rver === expectedVersion;
                                });

                            t.ok(allRecordsAtExpectedVersion,
                                'all records should be at version ' +
                                    expectedVersion.version);

                            done();
                        });
                },
                inputs: expectedResults
            }, function allVersionsChecked(err) {
                next(err);
            });
        },
        function checkNoBucketHasReindexingActive(arg, next) {
            var expectedResults = options.expectedResults;

            vasync.forEachPipeline({
                func: function checkNoReindexingActive(expectedResult, done) {
                    var bucketName = expectedResult.bucketName;
                    assert.string(bucketName, 'bucketName');

                    morayClient.getBucket(bucketName,
                        function onGetVmBucket(getBucketErr, bucket) {
                            var reindexActive =
                                bucket.reindex_active !== undefined &&
                                    Object.keys(bucket.reindex_active) > 0;

                            t.ok(!getBucketErr, 'Getting bucket ' + bucketName +
                                ' should not error');
                            t.ok(!reindexActive, 'bucket ' + bucketName +
                                ' should not be reindexing');

                            done();
                        });
                },
                inputs: expectedResults
            }, next);
        },
        function initVmapi(arg, next) {
            vmapiApp = new VmapiApp({
                apiClients: {
                    wfapi: MOCKED_WFAPI_CLIENT
                },
                changefeedPublisher: changefeedUtils.createNoopCfPublisher(),
                dataMigrationsCtrl: new NoopDataMigrationsController(),
                morayBucketsInitializer: morayBucketsInitializer,
                moray: storage
            });

            next();
        },
        function listenOnVmapiServer(arg, next) {
            vmapiApp.listen({
                port: 0
            }, next);
        },
        function testPingEndpoint(arg, next) {
            var vmapiClient;

            var vmapiServerAddress = vmapiApp.server.address();
            var vmapiServerUrl = 'http://' + vmapiServerAddress.address +
                ':' + vmapiServerAddress.port;

            vmapiClient = new VMAPI({
                url: vmapiServerUrl
            });

            vmapiClient.ping(function onVmapiPing(pingErr, obj) {
                var expectedErrValue = null;
                var expectedHealthiness = true;
                var expectedMorayInitStatus = 'BUCKETS_REINDEX_DONE';
                var expectedStatus = 'OK';

                t.equal(pingErr, undefined, 'ping endpoint should not error');
                t.equal(obj.status,
                    expectedStatus, 'status property of the response ' +
                        'message should be equal to "' +
                        expectedStatus + '"');
                t.equal(obj.healthy, expectedHealthiness,
                    'healthy property of the response message should ' +
                        ' be"' + expectedHealthiness + '"');
                t.equal(obj.initialization.moray.error, expectedErrValue,
                    'Error string for moray initialization error ' +
                        'should be: "' + expectedErrValue + '"');
                t.equal(obj.initialization.moray.status,
                    expectedMorayInitStatus,
                    'Error string for moray initialization error ' +
                        'should be: "' + expectedErrValue + '"');

                vmapiClient.close();

                next();
            });
        }
    ]}, function allMigrationTestsDone(migrationTestsErr) {
        t.equal(migrationTestsErr, undefined,
            'migration test should not error');

        if (vmapiApp) {
            vmapiApp.close();
        }

        morayClient.close();

        callback();
    });
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
            /*
             * noBucketCache: true is needed so that when putting objects in
             * moray after a bucket has been deleted and recreated, it doesn't
             * use an old bucket schema and determine that it needs to update an
             * _rver column that doesn't exist anymore.
             */
            morayClient.putObject(bucketName, objectUuid, newObjectValue,
                {noBucketCache: true}, done);
        },
        inputs: objectKeys
    }, callback);
}

exports.moray_init_bucket_versioning = function (t) {
    vasync.pipeline({funcs: [
        function cleanup(arg, next) {
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
        function setupOriginalMorayBuckets(arg, next) {
            var morayBucketsInitializer;
            var morayClient;
            var moraySetup = morayInit.startMorayInit({
                morayConfig: common.config.moray,
                morayBucketsConfig: testBucketsConfigV0,
                changefeedPublisher: changefeedUtils.createNoopCfPublisher()
            });
            var nextOnce = once(next);

            morayBucketsInitializer = moraySetup.morayBucketsInitializer;
            morayClient = moraySetup.morayClient;

            function cleanUp() {
                morayBucketsInitializer.removeAllListeners('error');
                morayBucketsInitializer.removeAllListeners('done');
                morayClient.close();
            }

            morayBucketsInitializer.on('done',
                function onMorayBucketsInit() {
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
        function writeTestObjects(arg, next) {
            var morayBucketsInitializer;
            var morayClient;
            var moraySetup = morayInit.startMorayInit({
                morayConfig: common.config.moray,
                morayBucketsConfig: testBucketsConfigV0,
                changefeedPublisher: changefeedUtils.createNoopCfPublisher()
            });

            morayBucketsInitializer = moraySetup.morayBucketsInitializer;
            morayClient = moraySetup.morayClient;

            morayBucketsInitializer.on('done',
                function onMorayBucketsInitialized() {
                    writeObjects(morayClient, VMS_BUCKET_NAME, {
                        indexed_property: 'foo'
                    }, NB_TEST_OBJECTS, function onTestObjectsWritten(err) {
                        t.ok(!err, 'writing test objects should not error');
                        morayClient.close();
                        next(err);
                    });
                });
        },
        /*
         * First, migrate from version 0 to 1, which is a valid migration and
         * results in the bucket storing VM objects to be at version 1.
         */
        function migrateFromV0ToV1(arg, next) {
            testMigrationToBucketsConfig(testBucketsConfigV1, {
                expectedResults: [
                    {
                        bucketName: VMS_BUCKET_NAME,
                        version: 1
                    }
                ]
            }, t, next);
        },
        /*
         * Then, attempt to migrate from version 1 to 0 (a downgrade), which is
         * a valid migration but results in the bucket storing VM objects to
         * stay at version 1.
         */
        function migrateFromV1ToV0(arg, next) {
            testMigrationToBucketsConfig(testBucketsConfigV0, {
                expectedResults: [
                    {
                        bucketName: VMS_BUCKET_NAME,
                        version: 1
                    }
                ]
            }, t, next);
        },
        /*
         * Finally, migrate from version 1 to 2, which is a valid migration and
         * results in the bucket storing VM objects to be at version 2.
         */
        function migrateFromV1ToV2(arg, next) {
            testMigrationToBucketsConfig(testBucketsConfigV2, {
                expectedResults: [
                    {
                        bucketName: VMS_BUCKET_NAME,
                        version: 2
                    }
                ]
            }, t, next);
        }
    ]}, function allMigrationsDone(allMigrationsErr) {
        t.equal(allMigrationsErr, undefined,
            'versioning test should not error');

        t.done();
    });
};
