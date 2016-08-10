/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * This test is about making sure that, when a non transient error is
 * encountered while setting up moray buckets, the MorayBucketsInitializer
 * instance emits an error event. Not handling that error event would make the
 * process exit , which is what we want to happen when running the VMAPI
 * service.
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

var VMS_BUCKET_CONFIG_WITH_ERROR = {
    name: 'vmapi_vms_test_non_transient_error',
    schema: {
        index: {
            uuid: { type: 'string', unique: true},
            owner_uuid: { type: 'string' },
            image_uuid: { type: 'string' },
            billing_id: { type: 'string' },
            server_uuid: { type: 'string' },
            package_name: { type: 'string' },
            package_version: { type: 'string' },
            tags: { type: 'string' },
            brand: { type: 'string' },
            state: { type: 'string' },
            alias: { type: 'string' },
            max_physical_memory: { type: 'number' },
            create_timestamp: { type: 'number' },
            /*
             * The typo in "booleaan" is intentional: it is used to trigger what
             * we consider to be a non-transient error when setting up VMAPI's
             * moray buckets, and test that the moray buckets setup process
             * handles this error appropriately, in that case by emitting an
             * 'erorr' event.
             */
            docker: { type: 'booleaan' }
        },
        options: {
            version: 1
        }
    }
};

var SERVER_VMS_MORAY_BUCKET_CONFIG = {
    name: 'vmapi_server_vms_test_non_transient_error',
    schema: {}
};

var ROLE_TAGS_MORAY_BUCKET_CONFIG = {
    name: 'vmapi_vm_role_tags_test_non_transient_error',
    schema: {
        index: {
            role_tags: { type: '[string]' }
        }
    }
};

var morayBucketsConfigWithError = {
    vms: VMS_BUCKET_CONFIG_WITH_ERROR,
    server_vms: SERVER_VMS_MORAY_BUCKET_CONFIG,
    vm_role_tags: ROLE_TAGS_MORAY_BUCKET_CONFIG
};

exports.moray_init_non_transient_error = function (t) {
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
        function initVmapi(arg, next) {
            morayStorage = new mod_morayStorage(morayClient);

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
            morayBucketsConfigWithError);

        morayBucketsInitializer.on('error',
            function onMorayBucketsInitError(morayErr) {
                t.ok(morayErr, 'moray initialization should error');

                vmapiClient.ping(function onVmapiPing(pingErr, obj) {
                    var errBody = pingErr.body;
                    var expectedStatus = 'some services are not ready';
                    var expectedHealthiness = false;
                    var expectedErrString =
                        'InvalidBucketConfigError: docker.type is invalid';

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
