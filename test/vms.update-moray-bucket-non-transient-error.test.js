/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
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
var VMAPI = require('sdc-clients').VMAPI;
var path = require('path');
var restify = require('restify');
var vasync = require('vasync');

var changefeedUtils = require('../lib/changefeed');
var common = require('./common');
var morayInit = require('../lib/moray/moray-init');
var NoopDataMigrationsController =
    require('../lib/data-migrations/noop-controller');
var testMoray = require('./lib/moray');
var VmapiApp = require('../lib/vmapi');

var VMS_BUCKET_CONFIG_WITH_ERROR = {
    name: 'test_vmapi_vms_non_transient_error',
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
             * 'error' event.
             */
            docker: { type: 'booleaan' }
        },
        options: {
            version: 1
        }
    }
};

var SERVER_VMS_MORAY_BUCKET_CONFIG = {
    name: 'test_vmapi_server_vms_non_transient_error',
    schema: {}
};

var ROLE_TAGS_MORAY_BUCKET_CONFIG = {
    name: 'test_vmapi_vm_role_tags_non_transient_error',
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
    var mockedWfapiClient = {
        connected: true,
        connect: function mockedWfapiConnect(callback) {
            callback();
        }
    };
    var morayBucketsInitializer;
    var morayClient;
    var moray;
    var vmapiApp;
    var vmapiClient;

    vasync.pipeline({funcs: [
        function cleanLeftoverTestBuckets(arg, next) {
            testMoray.cleanupLeftoverBuckets([
                morayBucketsConfigWithError.vms.name,
                morayBucketsConfigWithError.server_vms.name,
                morayBucketsConfigWithError.vm_role_tags.name
            ],
            function onCleanupLeftoverBuckets(cleanupErr) {
                t.ifError(cleanupErr,
                    'cleaning up leftover buckets should be successful');
                next(cleanupErr);
            });
        },
        function initMorayStorage(arg, next) {
            var moraySetup = morayInit.startMorayInit({
                morayConfig: common.config.moray,
                morayBucketsConfig: morayBucketsConfigWithError,
                changefeedPublisher: changefeedUtils.createNoopCfPublisher()
            });

            morayBucketsInitializer = moraySetup.morayBucketsInitializer;
            morayClient = moraySetup.morayClient;
            moray = moraySetup.moray;

            morayBucketsInitializer.on('error',
                function onMorayBucketsInitError(morayBucketsInitErr) {
                    t.ok(morayBucketsInitErr,
                        'moray initialization should error');
                    next();
                });
        },
        function initVmapi(arg, next) {
            vmapiApp = new VmapiApp({
                apiClients: {
                    wfapi: mockedWfapiClient
                },
                changefeedPublisher: changefeedUtils.createNoopCfPublisher(),
                dataMigrationsCtrl: new NoopDataMigrationsController(),
                morayBucketsInitializer: morayBucketsInitializer,
                moray: moray
            });

            next();
        },
        function listenOnVmapiServer(arg, next) {
            vmapiApp.listen({
                port: 0
            }, next);
        }
    ]}, function onVmapiServiceReady(initErr) {
        var vmapiServerAddress;
        var vmapiServerUrl;

        t.ifError(initErr, 'initialization of VMAPI app and its dependencies ' +
         'should be successful');

        if (initErr) {
            t.done();
            return;
        }

        vmapiServerAddress = vmapiApp.server.address();
        vmapiServerUrl = 'http://' + vmapiServerAddress.address +
            ':' + vmapiServerAddress.port;

        vmapiClient = new VMAPI({
            url: vmapiServerUrl
        });

        vmapiClient.ping(function onVmapiPing(pingErr, obj, req, res) {
            var errBody = pingErr.body;
            var expectedErrString = 'bucket.index[\'docker\'].type should be ' +
                'equal to one of the allowed values';
            var expectedHealthiness = false;
            var expectedResponseHttpStatus = 503;
            var expectedStatus = 'some services are not ready';
            var morayInitError;

            console.log('errBody:', errBody);

            t.equal(res.statusCode, expectedResponseHttpStatus,
                'Response\'s HTTP status code must be ' +
                    expectedResponseHttpStatus);
            t.equal(errBody.status,
                expectedStatus, 'status property of the error ' +
                    'message should be equal to "' + expectedStatus +
                    '"');
            t.equal(errBody.healthy, expectedHealthiness,
                'healthy property of the error message should be "' +
                    expectedHealthiness + '"');

            morayInitError = errBody.initialization.moray.error;
            t.ok(morayInitError.indexOf(expectedErrString) !== -1,
                'Error string for moray initialization error should ' +
                    'contain: "' + expectedErrString + '", but is: ' +
                    morayInitError);

            vmapiClient.close();
            vmapiApp.close();
            morayClient.close();
            t.done();
        });
    });
};
