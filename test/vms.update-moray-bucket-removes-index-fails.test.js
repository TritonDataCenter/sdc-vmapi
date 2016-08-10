/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * This test is about making sure that, when a moray bucket is changed in a way
 * that an index is removed, which is a backward incompatible change, the
 * MorayBucketsInitializer instance emits an error event.
 */

var jsprim = require('jsprim');
var Logger = require('bunyan');
var moray = require('moray');
var path = require('path');
var restify = require('restify');
var vasync = require('vasync');
var mod_vmapiClient = require('sdc-clients').VMAPI;

var configLoader = require('..//lib/config-loader');
var mod_morayStorage = require('../lib/storage/moray/moray');
var MorayBucketsInitializer =
    require('../lib/storage/moray/moray-buckets-initializer');
var vmapi = require('../lib/vmapi');

var configFilePath = path.join(__dirname, '../config.json');
var config = configLoader.loadConfig(configFilePath);

var VMS_BUCKET_CONFIG_V0 = {
    name: 'vmapi_vms_test_invalid_index_removal',
    schema: {
        index: {
            uuid: { type: 'string', unique: true},
            some_index: { type: 'string' }
        }
    }
};

var VMS_BUCKET_CONFIG_V1 = {
    name: 'vmapi_vms_test_invalid_index_removal',
    schema: {
        index: {
            uuid: { type: 'string', unique: true}
        },
        options: {
            version: 1
        }
    }
};

var SERVER_VMS_MORAY_BUCKET_CONFIG = {
    name: 'vmapi_server_vms_test_invalid_index_removal',
    schema: {}
};

var ROLE_TAGS_MORAY_BUCKET_CONFIG = {
    name: 'vmapi_vm_role_tags_test_invalid_index_removal',
    schema: {
        index: {
            role_tags: { type: '[string]' }
        }
    }
};

var morayBucketsConfigV0 = {
    vms: VMS_BUCKET_CONFIG_V0,
    server_vms: SERVER_VMS_MORAY_BUCKET_CONFIG,
    vm_role_tags: ROLE_TAGS_MORAY_BUCKET_CONFIG
};

var morayBucketsConfigV1 = {
    vms: VMS_BUCKET_CONFIG_V1,
    server_vms: SERVER_VMS_MORAY_BUCKET_CONFIG,
    vm_role_tags: ROLE_TAGS_MORAY_BUCKET_CONFIG
};

exports.moray_init_invalid_index_removal = function (t) {
    var morayClient;
    var morayStorage;
    var vmapiService;

    var mockedWfapiClient = {
        connected: true,
        connect: function mockedWfapiConnect(callback) {
            callback();
        }
    };

    var vmapiClient;

    vasync.pipeline({funcs: [
        function connectToMoray(arg, next) {
            var morayClientConfig = jsprim.deepCopy(config.moray);
            morayClientConfig.retry = {
                retries: Infinity,
                minTimeout: 100,
                maxTimeout: 1000
            };

            morayClientConfig.log = new Logger({
                name: 'moray-client',
                level: config.logLevel,
                serializers: restify.bunyan.serializers
            });

            morayClient = moray.createClient(morayClientConfig);

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
        function setupMorayBucketsFirstVersion(arg, next) {
            morayStorage = new mod_morayStorage(morayClient);
            morayStorage.setupBuckets(morayBucketsConfigV0, next);
        },
        function initVmapi(arg, next) {

            vmapiService = new vmapi({
                apiClients: {
                    wfapi: mockedWfapiClient
                },
                storage: morayStorage
            });

            vmapiService.init(next);
        },
        function listenOnVmapiServer(arg, next) {
            vmapiService.listen({
                port: 0
            }, next);
        }
    ]}, function onVmapiServiceReady(initErr) {
        var vmapiServerAddress = vmapiService.server.address();
        var vmapiServerUrl = 'http://' + vmapiServerAddress.address +
            ':' + vmapiServerAddress.port;

        vmapiClient = new mod_vmapiClient({
            url: vmapiServerUrl
        });

        var morayBucketsInitializer = new MorayBucketsInitializer();
        morayBucketsInitializer.start(morayStorage,
            morayBucketsConfigV1);

        morayBucketsInitializer.on('error',
            function onMorayBucketsInitError(morayErr) {
                t.ok(morayErr, 'moray initialization should error');

                vmapiClient.ping(function onVmapiPing(pingErr, obj) {
                    var errBody = pingErr.body;
                    var expectedStatus = 'some services are not ready';
                    var expectedHealthiness = false;
                    var expectedErrString =
                        'InvalidIndexesRemovalError: Invalid removal of ' +
                            'indexes: some_index';

                    t.equal(errBody.status,
                        expectedStatus, 'status property of the error ' +
                            'message should be equal to "' + expectedStatus +
                            '"');
                    t.equal(errBody.healthy, expectedHealthiness,
                        'healthy property of the error message should be "' +
                            expectedHealthiness + '"');
                    t.equal(errBody.services.moray.initialization.error,
                        expectedErrString,
                        'Error string for moray initialization error should ' +
                            'be: "' + expectedErrString + '"');

                    vmapiClient.close();
                    vmapiService.close();
                    morayClient.close();
                    t.done();
                });
            });
    });
};
