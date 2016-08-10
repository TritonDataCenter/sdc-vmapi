/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
var jsprim = require('jsprim');
var Logger = require('bunyan');
var moray = require('moray');
var path = require('path');
var restify = require('restify');
var vasync = require('vasync');
var verror = require('verror');
var mod_vmapiClient = require('sdc-clients').VMAPI;

var configLoader = require('..//lib/config-loader');
var morayStorage = require('../lib/storage/moray/moray');
var vmapi = require('../lib/vmapi');

var configFilePath = path.join(__dirname, '../config.json');
var config = configLoader.loadConfig(configFilePath);

var MOCKED_WFAPI_CLIENT = {
    connected: true,
    connect: function mockedWfapiConnect(callback) {
        callback();
    }
};

var VMS_BUCKET_NAME = 'vmapi_vms_test_versioning';
var SERVER_VMS_BUCKET_NAME = 'vmapi_server_vms_test_versioning';
var ROLE_TAGS_BUCKET_NAME = 'vmapi_vm_role_tags_test_versioning';

/*
 * Initial buckets configuration, version 0.
 */
var VMS_BUCKET_CONFIG_V0 = {
    name: VMS_BUCKET_NAME,
    schema: {
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
 * "some_property". The upgrade from version 0 to version 1 is valid.
 */
var VMS_BUCKET_CONFIG_V1 = {
    name: VMS_BUCKET_NAME,
    schema: {
        index: {
            some_property: { type: 'boolean' }
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

function filterBucketNotFoundErr(err) {
    assert.object(err, 'err');
    return err.name !== 'BucketNotFoundError';
}

function testMigrationToBucketsConfig(bucketsConfig, options, t, callback) {
    assert.object(bucketsConfig, 'bucketsConfig');
    assert.object(options, 'options');
    assert.object(options.morayClient, 'options.morayClient');
    assert.number(options.expectedResultingVersion,
        'options.expectedResultingVersion');
    assert.object(t, 't');
    assert.func(callback, 'callback');

    var morayClient = options.morayClient;
    var storage = new morayStorage(morayClient);

    var vmapiService;

    vasync.pipeline({funcs: [
        function initMorayBuckets(arg, next) {
            storage.setupBuckets(bucketsConfig, next);
        },
        function initVmapi(arg, next) {
            vmapiService = new vmapi({
                apiClients: {
                    wfapi: MOCKED_WFAPI_CLIENT
                },
                storage: storage
            });

            vmapiService.init(next);
        },
        function listenOnVmapiServer(arg, next) {
            vmapiService.listen({
                port: 0
            }, next);
        },
        function testPingEndpoint(arg, next) {
            var vmapiClient;

            var vmapiServerAddress = vmapiService.server.address();
            var vmapiServerUrl = 'http://' + vmapiServerAddress.address +
                ':' + vmapiServerAddress.port;

            vmapiClient = new mod_vmapiClient({
                url: vmapiServerUrl
            });

            vmapiClient.ping(function onVmapiPing(pingErr, obj) {
                var expectedStatus = 'OK';
                var expectedHealthiness = true;
                var expectedErrValue = null;

                t.equal(pingErr, undefined, 'ping endpoint should not error');
                t.equal(obj.status,
                    expectedStatus, 'status property of the response ' +
                        'message should be equal to "' +
                        expectedStatus + '"');
                t.equal(obj.healthy, expectedHealthiness,
                    'healthy property of the response message should ' +
                        ' be"' + expectedHealthiness + '"');
                t.equal(obj.services.moray.initialization.error,
                    expectedErrValue,
                    'Error string for moray initialization error ' +
                        'should be: "' + expectedErrValue + '"');

                vmapiClient.close();

                next();
            });
        },
        function checkExpectedVersion(arg, next) {
            var expectedVersion = options.expectedResultingVersion;

            morayClient.getBucket(bucketsConfig.vms.name,
                function onVMsBucket(err, vmsBucket) {
                    t.equal(vmsBucket.options.version, expectedVersion,
                        'Bucket with name ' + bucketsConfig.vms.name +
                            ' should be at version ' + expectedVersion);

                    next();
                });
        }
    ]}, function allMigrationTestsDone(migrationTestsErr) {
        t.equal(migrationTestsErr, undefined,
            'migration test should not error');

        if (vmapiService) {
            vmapiService.close();
        }

        callback();
    });
}

exports.moray_init_bucket_versioning = function (t) {
    var morayClient;

    vasync.pipeline({funcs: [
        function connectToMoray(arg, next) {
            var morayClientOpts = jsprim.deepCopy(config.moray);
            morayClientOpts.retry = {
                retries: Infinity,
                minTimeout: 100,
                maxTimeout: 1000
            };

            morayClientOpts.log = new Logger({
                name: 'moray-client',
                level: config.logLevel,
                serializers: restify.bunyan.serializers
            });

             morayClient = moray.createClient(morayClientOpts);

             morayClient.on('connect', function onMorayClientConnected() {
                next();
            });

            morayClient.on('error', function onMorayClientConnectionError(err) {
                /*
                 * The current semantics of the underlying node-moray client
                 * connection means that it can emit 'error' events for errors
                 * that the client can actually recover from and that don't
                 * prevent it from establishing a connection. See MORAY-309 for
                 * more info.
                 *
                 * Since it's expected that, at least in some testing
                 * environments, the moray client will fail to connect a certain
                 * number of times, aborting tests in that case would mean that
                 * tests would fail most of the time, even though they should
                 * pass. Instead, we explicitly ignore errors and retry
                 * connecting indefinitely. If the moray client is not able to
                 * connect, then the process will hang or time out.
                 */
            });
        },
        function cleanupLeftoverBuckets(arg, next) {
            vasync.forEachParallel({
                func: function deleteVmBucket(bucketName, done) {
                    morayClient.delBucket(bucketName, done);
                },
                inputs: [
                    VMS_BUCKET_NAME,
                    SERVER_VMS_BUCKET_NAME,
                    ROLE_TAGS_BUCKET_NAME
                ]
            }, function onAllLeftoverBucketsDeleted(deleteErrs) {
                var unexpectedErrs;
                var forwardedMultiErr;

                if (deleteErrs) {
                    unexpectedErrs =
                        deleteErrs.ase_errors.filter(filterBucketNotFoundErr);

                    if (unexpectedErrs && unexpectedErrs.length > 0) {
                        forwardedMultiErr =
                            new verror.MultiError(unexpectedErrs);
                    }
                }

                next(forwardedMultiErr);
            });
        },
        function setupOriginalMorayBuckets(arg, next) {
            testMigrationToBucketsConfig(testBucketsConfigV0, {
                morayClient: morayClient,
                expectedResultingVersion: 0
            }, t, next);
        },
        function migrateFromV0ToV1(arg, next) {
            testMigrationToBucketsConfig(testBucketsConfigV1, {
                morayClient: morayClient,
                expectedResultingVersion: 1
            }, t, next);
        },
        function migrateFromV1ToV0(arg, next) {
            testMigrationToBucketsConfig(testBucketsConfigV0, {
                morayClient: morayClient,
                expectedResultingVersion: 1
            }, t, next);
        }
    ]}, function allMigrationsDone(allMigrationsErr) {
        t.equal(allMigrationsErr, undefined,
            'versioning test should not error');

        if (morayClient) {
            morayClient.close();
        }

        t.done();
    });
};
