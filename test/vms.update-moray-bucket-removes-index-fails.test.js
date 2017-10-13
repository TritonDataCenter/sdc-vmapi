/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * This test is about making sure that, when a moray bucket is changed in a way
 * that an index is removed, which is a backward incompatible change, the
 * MorayBucketsInitializer instance emits an error event.
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

var VMS_BUCKET_CONFIG_V0 = {
    name: 'test_vmapi_vms_invalid_index_removal',
    schema: {
        index: {
            uuid: { type: 'string', unique: true},
            some_index: { type: 'string' }
        }
    }
};

var VMS_BUCKET_CONFIG_V1 = {
    name: 'test_vmapi_vms_invalid_index_removal',
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
    name: 'test_vmapi_server_vms_invalid_index_removal',
    schema: {}
};

var ROLE_TAGS_MORAY_BUCKET_CONFIG = {
    name: 'test_vmapi_vm_role_tags_invalid_index_removal',
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

var morayBucketsInitializer;

exports.moray_init_invalid_index_removal = function (t) {
    var morayClient;
    var moray;
    var vmapiApp;

    var mockedWfapiClient = {
        connected: true,
        connect: function mockedWfapiConnect(callback) {
            callback();
        }
    };

    var vmapiClient;

    vasync.pipeline({funcs: [
        function cleanLeftoverTestBuckets(arg, next) {
            testMoray.cleanupLeftoverBuckets([
                morayBucketsConfigV0.vms.name,
                morayBucketsConfigV0.server_vms.name,
                morayBucketsConfigV0.vm_role_tags.name
            ],
            function onCleanupLeftoverBuckets(cleanupErr) {
                t.ifError(cleanupErr,
                    'cleaning up leftover buckets should be successful');
                next(cleanupErr);
            });
        },
        function setupMorayWithBucketsFirstVersion(arg, next) {
            var moraySetup = morayInit.startMorayInit({
                morayConfig: common.config.moray,
                morayBucketsConfig: morayBucketsConfigV0,
                changefeedPublisher: changefeedUtils.createNoopCfPublisher()
            });

            morayBucketsInitializer = moraySetup.morayBucketsInitializer;
            morayClient = moraySetup.morayClient;
            moray = moraySetup.moray;

            morayBucketsInitializer.on('done',
                function onMorayBucketsInit() {
                    t.ok(true,
                        'moray buckets initialization with correct ' +
                            'configuration should be successfull');

                    morayClient.close();

                    next();
                });
        },
        function setupMorayWithIncorrectBucketsConfig(arg, next) {
            var moraySetup = morayInit.startMorayInit({
                morayConfig: common.config.moray,
                morayBucketsConfig: morayBucketsConfigV1,
                changefeedPublisher: changefeedUtils.createNoopCfPublisher()
            });

            morayBucketsInitializer = moraySetup.morayBucketsInitializer;
            morayClient = moraySetup.morayClient;
            moray = moraySetup.moray;

            morayBucketsInitializer.on('error',
                function onMorayBucketsInit() {
                    t.ok(true,
                        'moray buckets initialization with incorrect ' +
                            'configuration should error');

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
        var vmapiServerAddress = vmapiApp.server.address();
        var vmapiServerUrl = 'http://' + vmapiServerAddress.address +
            ':' + vmapiServerAddress.port;

        vmapiClient = new VMAPI({
            url: vmapiServerUrl
        });

        vmapiClient.ping(function onVmapiPing(pingErr, obj, req, res) {
            var errBody = pingErr.body;
            var expectedErrString =
                'InvalidIndexesRemovalError: Invalid removal of ' +
                    'indexes: some_index';
            var expectedHealthiness = false;
            var expectedResponseHttpStatus = 503;
            var expectedStatus = 'some services are not ready';

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
            t.equal(errBody.initialization.moray.error, expectedErrString,
                'Error string for moray initialization error should ' +
                    'be: "' + expectedErrString + '"');

            vmapiClient.close();
            vmapiApp.close();
            morayClient.close();
            t.done();
        });
    });
};
