/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var jsprim = require('jsprim');
var path = require('path');
var restify = require('restify');
var util = require('util');
var vasync = require('vasync');
var VError = require('verror');
var VMAPI = require('sdc-clients').VMAPI;

var changefeedUtils = require('../lib/changefeed');
var common = require('./common');
var morayInit = require('../lib/moray/moray-init');
var testMoray = require('./lib/moray.js');
var VmapiApp = require('../lib/vmapi');

var MOCKED_METRICS_MANAGER = {
    update: function () {}
};

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
            /*
             * The "uuid" and "internal_metadata_search_array" indexes are
             * required to be able to make sure that filtering on
             * "internal_metadata" works as expected once all data migrations
             * completed successfully.
             */
            uuid: { type: 'string' },
            internal_metadata_search_array: { type: '[string]'},
            data_version: { type: 'number' }
        },
        options: {
            version: 1
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

    var allRecords = [];

    var findAllObjectsReq = morayClient.findObjects(bucketName, filter);

    findAllObjectsReq.once('error', function onError(findErr) {
        cleanup();
        callback(findErr);
    });

    findAllObjectsReq.on('record', function onRecord(record) {
        allRecords.push(record);
    });

    findAllObjectsReq.once('end', function onGotAllRecords() {
        cleanup();
        callback(null, allRecords);
    });

    function cleanup() {
        findAllObjectsReq.removeAllListeners('error');
        findAllObjectsReq.removeAllListeners('record');
        findAllObjectsReq.removeAllListeners('end');
    }
}

exports.data_migrations = function (t) {
    var context = {};
    var TRANSIENT_ERROR_MSG = 'Mocked transient error';

    vasync.pipeline({arg: context, funcs: [
        function cleanupBuckets(ctx, next) {
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
        /*
         * Start the buckets initialization process again after injecting a
         * transient error in the data migration process. This way we can check
         * that VMAPI reacts properly to errors at this specific stage of the
         * buckets init process. When we're done, we'll remove the injected
         * transient error, and make sure VMAPI can provide the functionality
         * that depends on data migrations successfully.
         */
        function startDataMigrationsWithTransientErr(ctx, next) {
            var morayBucketsInitializer;
            var morayClient;
            var moraySetup;

            moraySetup = morayInit.startMorayInit({
                changefeedPublisher: changefeedUtils.createNoopCfPublisher(),
                dataMigrationsPath: path.join(__dirname, 'fixtures',
                    'data-migrations-valid'),
                morayConfig: common.config.moray,
                morayBucketsConfig: TEST_BUCKETS_CONFIG
            });

            ctx.moray = moraySetup.moray;
            ctx.morayBucketsInitializer = morayBucketsInitializer =
                moraySetup.morayBucketsInitializer;
            ctx.morayClient = morayClient = moraySetup.morayClient;

            ctx.originalBatch = ctx.morayClient.batch;
            ctx.morayClient.batch =
                function mockedBatch(listOpts, callback) {
                    assert.arrayOfObject(listOpts, 'listOpts');
                    assert.func(callback, 'callback');

                    callback(new Error(TRANSIENT_ERROR_MSG));
                };

            ctx.morayBucketsInitializer.once('done',
                function onBucketsInitDone() {
                    t.ok(false, 'Moray buckets init should not complete when ' +
                        'transient error injected in data migrations');
                });

            ctx.morayBucketsInitializer.once('error',
                function onBucketsInitError(bucketsInitErr) {
                    t.ok(false, 'Moray buckets init should not error when ' +
                        'transient error injected in data migrations');
                });
            /*
             * Move on to the next step of this test only when reindexing has
             * completed successfully, so that we know that at some point (once
             * all buckets caches are refreshed) we can test that the search on
             * internal_metadata should be successful, since the required index
             * will be present.
             */
            ctx.morayBucketsInitializer.once('buckets-reindex-done',
                function onBucketsSetupDone() {
                    t.ok(true, 'Moray buckets setup should complete when ' +
                        'transient error injected in data migrations');
                    next();
                });
        },
        function writeTestObjects(ctx, next) {
            assert.object(ctx.morayClient, 'ctx.morayClient');

            testMoray.writeObjects(ctx.morayClient, VMS_BUCKET_NAME, {
                foo: 'foo'
            }, NUM_TEST_OBJECTS, function onTestObjectsWritten(writeErr) {
                t.ok(!writeErr, 'writing test objects should not error, got: ' +
                    util.inspect(writeErr));
                next(writeErr);
            });
        },
        function startVmapiService(ctx, next) {
            ctx.vmapiApp = new VmapiApp({
                apiClients: {
                    wfapi: MOCKED_WFAPI_CLIENT
                },
                changefeedPublisher: changefeedUtils.createNoopCfPublisher(),
                metricsManager: MOCKED_METRICS_MANAGER,
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
        function checkDataMigrationsTransientError(ctx, next) {
            var MAX_NUM_TRIES;
            /*
             * We wait for the moray bucket cache to be refreshed on all Moray
             * instances, which can be up to 5 minutes currently, and then some.
             * This is the maximum delay during which InvalidQueryError can
             * occur due to stale buckets cache, after which only the transient
             * error injected by this test should surface.
             */
            var MAX_TRIES_DURATION_IN_MS = 6 * 60 * 1000;
            var NUM_TRIES = 0;
            var RETRY_DELAY_IN_MS = 10000;

            MAX_NUM_TRIES = MAX_TRIES_DURATION_IN_MS / RETRY_DELAY_IN_MS;

            assert.object(ctx.vmapiClient, 'ctx.vmapiClient');

            function doCheckMigrationsStatus() {
                ++NUM_TRIES;

                ctx.vmapiClient.ping(function onPing(pingErr, obj, req, res) {
                    var foundExpectedErrMsg;
                    var latestVmsMigrationsErr;
                    var morayInitStatus;

                    t.ok(!pingErr, 'pinging VMAPI when data migrations fail ' +
                        'should return a non-error status, got: ' + pingErr);
                    t.ok(obj, 'pinging VMAPI when data migrations fail ' +
                        'should return a non-empty response, got: ' + obj);

                    if (obj) {
                        morayInitStatus = obj.initialization.moray;
                    }

                    if (morayInitStatus && morayInitStatus.dataMigrations &&
                        morayInitStatus.dataMigrations.latestErrors &&
                        morayInitStatus.dataMigrations.latestErrors.vms) {
                        latestVmsMigrationsErr =
                            morayInitStatus.dataMigrations.latestErrors.vms;
                        foundExpectedErrMsg =
                            latestVmsMigrationsErr.indexOf(TRANSIENT_ERROR_MSG)
                                !== -1;
                        t.ok(foundExpectedErrMsg,
                            'data migrations latest error should include ' +
                                TRANSIENT_ERROR_MSG + ', got: ' +
                                latestVmsMigrationsErr);
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
            ctx.morayBucketsInitializer.removeAllListeners('done');
            ctx.morayBucketsInitializer.removeAllListeners('error');

            ctx.morayClient.batch = ctx.originalBatch;

            ctx.morayBucketsInitializer.once('done',
                function onBucketsInitDone() {
                    t.ok(true,
                        'Moray buckets init should eventually complete ' +
                            'successfully after removing transient error');
                    next();
                });

            ctx.morayBucketsInitializer.once('error',
                function onBucketsINitError(bucketsInitErr) {
                    t.ok(false, 'Moray buckets init should not error after ' +
                        'removing transient error, got: ',
                            util.inspect(bucketsInitErr));
                    next(bucketsInitErr);
                });
        },
        function checkDataMigrationsDone(ctx, next) {
            var latestExpectedCompletedVmsMigration = 1;

            assert.object(ctx.vmapiClient, 'ctx.vmapiClient');

            ctx.vmapiClient.ping(function onVmapiPing(pingErr, obj, req, res) {
                var latestCompletedMigrations;
                var morayInitStatus;

                t.ok(!pingErr, 'ping VMAPI when data migrations suceeded ' +
                    'should not error, got: ' + pingErr);
                t.ok(obj, 'pinging VMAPI when data migrations succeeded ' +
                    'should return a non-empty response');

                if (obj) {
                    morayInitStatus = obj.initialization.moray;
                }

                if (morayInitStatus && morayInitStatus.dataMigrations) {
                    latestCompletedMigrations =
                        morayInitStatus.dataMigrations.completed;
                    t.equal(latestCompletedMigrations.vms,
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
        },
        /*
         * Eventually, when all buckets caches are refreshed on all Moray
         * instances, and since we know all data migrations succeeded, we should
         * be able to search on the internal_metadata field.
         */
        function checkInternalMetadataSearchSuccess(ctx, next) {
            var expectedErrMsg = 'invalid filter';
            var MAX_NUM_TRIES;
            /*
             * We wait for the moray bucket cache to be refreshed on all Moray
             * instances, which can be up to 5 minutes currently, and then some.
             * This is the maximum delay during which InvalidQueryError can
             * occur due to stale buckets cache.
             */
            var MAX_TRIES_DURATION_IN_MS = 6 * 60 * 1000;
            var NUM_TRIES = 0;
            var RETRY_DELAY_IN_MS = 10000;

            MAX_NUM_TRIES = MAX_TRIES_DURATION_IN_MS / RETRY_DELAY_IN_MS;

            assert.object(ctx.vmapiClient, 'ctx.vmapiClient');

            function listVmsWithInternalMetadataFilter() {
                ++NUM_TRIES;

                ctx.vmapiClient.listVms({'internal_metadata.foo': 'bar'},
                    function onListVms(listVmsErr, vms, req, res) {
                        if (listVmsErr && NUM_TRIES < MAX_NUM_TRIES &&
                            listVmsErr.body && listVmsErr.body.message &&
                            listVmsErr.body.message.indexOf(expectedErrMsg) !==
                            -1) {
                            t.ok(true, 'Got expected transient error, ' +
                                'retrying in ' + RETRY_DELAY_IN_MS + 'ms...');
                            setTimeout(listVmsWithInternalMetadataFilter,
                                RETRY_DELAY_IN_MS);
                        } else {
                            t.ok(!listVmsErr,
                                'searching on internal_metadata when the ' +
                                'corresponding data migration has ' +
                                'completed should not error');
                            next();
                        }
                    });
            }

            listVmsWithInternalMetadataFilter();
        }
    ]}, function allMigrationsDone(allMigrationsErr) {
        t.ok(!allMigrationsErr, 'data migrations test should not error');

        if (context.morayClient) {
            context.morayClient.close();
        }

        if (context.vmapiClient) {
            context.vmapiClient.close();
        }

        if (context.vmapiApp) {
            context.vmapiApp.close();
        }

        t.done();
    });
};
