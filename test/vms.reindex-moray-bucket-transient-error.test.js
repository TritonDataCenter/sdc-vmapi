/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * This test is about making sure that, when a transient error is encountered by
 * the moray buckets reindexing process, the process is retried until that error
 * is resolved. This test also makes sure that, in the meantime, VMAPI's /ping
 * endpoint responds with an "OK" status, but still includes the reindexing
 * error in its moray initialization status. Finally, it also makes sure that
 * listing VMs succeeds while the reindexing process encounters transient
 * errors.
 */

var assert = require('assert-plus');
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
var VmapiApp = require('../lib/vmapi');

var TRANSIENT_ERROR_MSG = 'Mocked transient error';

var VMS_BUCKET_CONFIG = {
    name: 'test_vmapi_vms_reindex_transient_error',
    schema: {
        index: {
            uuid: { type: 'string', unique: true}
        }
    }
};

var SERVER_VMS_MORAY_BUCKET_CONFIG = {
    name: 'test_vmapi_server_vms_reindex_transient_error',
    schema: {}
};

var ROLE_TAGS_MORAY_BUCKET_CONFIG = {
    name: 'test_vmapi_vm_role_tags_reindex_transient_error',
    schema: {
        index: {
            role_tags: { type: '[string]' }
        }
    }
};

var MORAY_BUCKETS_CONFIG = {
    vms: VMS_BUCKET_CONFIG,
    server_vms: SERVER_VMS_MORAY_BUCKET_CONFIG,
    vm_role_tags: ROLE_TAGS_MORAY_BUCKET_CONFIG
};

exports.moray_init_transient_error = function (t) {
    var morayBucketsInitializer;
    var morayClient;
    var moray;
    var origMorayReindexBucket;

    var mockedWfapiClient = {
        connected: true,
        connect: function mockedWfapiConnect(callback) {
            callback();
        }
    };

    var vmapiApp;
    var vmapiClient;

    vasync.pipeline({funcs: [
        function initMorayStorage(arg, next) {
            var moraySetup = morayInit.startMorayInit({
                morayConfig: common.config.moray,
                morayBucketsConfig: MORAY_BUCKETS_CONFIG,
                changefeedPublisher: changefeedUtils.createNoopCfPublisher()
            });

            morayBucketsInitializer = moraySetup.morayBucketsInitializer;
            morayClient = moraySetup.morayClient;

            moray = moraySetup.moray;
            origMorayReindexBucket = moray._reindexBucket;

            next();
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
            }, function onVmapiListen() {
                var vmapiServerAddress = vmapiApp.server.address();
                var vmapiServerUrl = 'http://' + vmapiServerAddress.address +
                    ':' + vmapiServerAddress.port;

                vmapiClient = new VMAPI({
                    url: vmapiServerUrl
                });

                next();
            });
        },
        function initMorayWithTransientError(arg, next) {
            /*
             * Monkey patch VMAPI's moray layer "_reindexBucket" method to
             * inject a transient error, so that we can test that the moray
             * initializer and the VMAPI API behave correctly in that case.
             */
            moray._reindexBucket =
                function _reindexBucket(bucketName, callback) {
                    callback(new Error(TRANSIENT_ERROR_MSG));
                };

            morayBucketsInitializer.once('done', onMorayBucketsInitDone);
            morayBucketsInitializer.once('error', onMorayBucketsInitError);

            function onMorayBucketsInitDone() {
                t.ok(false, 'moray buckets init should not complete when ' +
                    'transient error injected');
                morayBucketsInitializer.removeAllListeners('error');
            }

            function onMorayBucketsInitError(morayBucketsInitError) {
                t.ok(false, 'moray buckets init should not error when ' +
                    'transient error injected');
                morayBucketsInitializer.removeAllListeners('done');
            }

            next();
        },
        function checkMorayStatusWithTransientErr(arg, next) {
            var nbVmapiStatusCheckSoFar = 0;
            var MAX_NB_VMAPI_STATUS_CHECKS = 10;
            var VMAPI_STATUS_CHECKS_DELAY = 1000;

            function checkPingTransientErr(callback) {
                vmapiClient.ping(function onVmapiPing(pingErr, obj, req, res) {
                    var expectedErrString = 'Error: ' + TRANSIENT_ERROR_MSG;
                    /*
                     * Even though we expect the "status" to be OK (which means
                     * that VMAPI is functional), a transient reindexing error
                     * still represents a backend initialization issue, and so
                     * we expect the "healthiness" to be false.
                     */
                    var expectedHealthiness = false;
                    var expectedMorayInitStatus = 'BUCKETS_SETUP_DONE';
                    var expectedStatus = 'OK';

                    if (obj &&
                        obj.status === expectedStatus &&
                        obj.healthy === expectedHealthiness &&
                        obj.initialization.moray.status ===
                            expectedMorayInitStatus &&
                        obj.initialization.moray.error ===
                            expectedErrString) {
                        callback(true);
                    } else {
                        callback(false);
                    }
                });
            }

            function scheduleVmapiCheckTransientErr() {
                if (nbVmapiStatusCheckSoFar <
                    MAX_NB_VMAPI_STATUS_CHECKS) {
                    ++nbVmapiStatusCheckSoFar;

                    function transientErrChecked(gotTransientErr) {
                        if (!gotTransientErr) {
                            setTimeout(scheduleVmapiCheckTransientErr,
                                VMAPI_STATUS_CHECKS_DELAY);
                        } else {
                            t.ok(true, 'Status endpoint did respond with ' +
                                'expected status');
                            next();
                        }
                    }

                    checkPingTransientErr(transientErrChecked);
                } else {
                    t.ok(false, 'Status endpoint did not respond with ' +
                        'expected status');
                    next();
                }
            }

            scheduleVmapiCheckTransientErr();
        },
        function listVmsWithMorayReindexTransientErr(arg, next) {
            vmapiClient.listVms({
                limit: 1
            }, function onListVms(listVmsErr, vms) {
                t.ifError(listVmsErr,
                    'listing VMs when moray not initialized due to a ' +
                        'transient reindexing error should succeed');

                next();
            });
        },
        function pingWithMorayInitOK(arg, next) {
            /*
             * Now, we're restoring the original function that we had modified
             * to introduce a transient error. As a result, the
             * MorayBucketsInitializer instance should be able to complete the
             * initialization of moray buckets, and the 'done' or 'error' events
             * will be emitted. Thus, we need to clear any listener that were
             * previously added for these events before adding new ones that
             * perform the tests that we want to perform now that the transient
             * error is not injected anymore.
             */
            morayBucketsInitializer.removeAllListeners('error');
            morayBucketsInitializer.removeAllListeners('done');

            morayBucketsInitializer.once('done', onMockedMorayBucketsInitDone);
            morayBucketsInitializer.once('error',
                onMockedMorayBucketsInitFailed);

            moray._reindexBucket = origMorayReindexBucket;

            function onMockedMorayBucketsInitDone() {
                vmapiClient.ping(function onVmapiPing(pingErr, obj, req, res) {
                    var actualMorayInitStatus = obj.initialization.moray.status;
                    var expectedMorayInitStatus = 'BUCKETS_REINDEX_DONE';
                    var expectedResponseHttpStatus = 200;

                    t.equal(res.statusCode, expectedResponseHttpStatus,
                        'Response\'s HTTP status code should be ' +
                            expectedResponseHttpStatus);
                    t.equal(pingErr, null, 'ping endpoint should not ' +
                        'error when no error injected in moray ' +
                        'initialization');
                    t.equal(actualMorayInitStatus, expectedMorayInitStatus,
                        'Moray initialization status should be: ' +
                            expectedMorayInitStatus + ' and is: ' +
                            actualMorayInitStatus);
                    t.equal(obj.initialization.moray.error, undefined,
                        'Moray initialization status should have no error');

                    morayBucketsInitializer.removeAllListeners('error');
                    next();
                });
            }

            function onMockedMorayBucketsInitFailed(morayBucketsSetupErr) {
                t.equal(morayBucketsSetupErr, undefined,
                    'moray buckets init should be successful');
                morayBucketsInitializer.removeAllListeners('done');
                next();
            }
        },
        function listVmsWithMorayInitOK(arg, next) {
            vmapiClient.listVms({
                limit: 1
            }, function onListVms(listVmsErr, vms) {
                t.ok(!listVmsErr,
                    'listing VMs when moray initialized should succeed');
                next();
            });
        }
    ]}, function onAllTestsDone(err) {
        vmapiClient.close();
        vmapiApp.close();
        morayClient.close();

        t.done();
    });
};
