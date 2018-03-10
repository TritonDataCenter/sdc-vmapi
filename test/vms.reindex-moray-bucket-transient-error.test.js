/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * This test is about making sure that, when a transient error is encountered by
 * the moray buckets reindexing process, VMAPI's /ping endpoint responds with an
 * "OK" status, but still includes the reindexing error in its moray
 * initialization status. Finally, it also makes sure that listing VMs succeeds
 * while the reindexing process encounters transient errors.
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
var VmapiApp = require('../lib/vmapi');

var TRANSIENT_ERROR_MSG = 'Mocked transient error';

exports.moray_init_transient_error = function (t) {
    var moray;
    var morayBucketsInitializer;
    var morayClient;
    var origMorayReindexObjects;

    var mockedMetricsManager = {
        update: function () {}
    };

    var mockedWfapiClient = {
        connected: true,
        connect: function mockedWfapiConnect(callback) {
            callback();
        }
    };

    var vmapiApp;
    var vmapiClient;

    vasync.pipeline({funcs: [
        function initMorayWithTransientError(arg, next) {
            var moraySetup = morayInit.startMorayInit({
                morayConfig: common.config.moray,
                changefeedPublisher: changefeedUtils.createNoopCfPublisher()
            });

            moray = moraySetup.moray;
            morayBucketsInitializer = moraySetup.morayBucketsInitializer;
            morayClient = moraySetup.morayClient;

            origMorayReindexObjects = morayClient.reindexObjects;

            /*
             * Monkey patch the Moray client's "reindexObjects" method to inject
             * a transient error, so that we can test that VMAPI API behave
             * correctly in that case.
             */
            morayClient.reindexObjects =
                function _mockedReindexObjects(bucketName, nbObjs, callback) {
                    assert.string(bucketName, 'bucketName');
                    assert.number(nbObjs, 'nbObjs');
                    assert.func(callback, 'callback');

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
        function initVmapi(arg, next) {
             vmapiApp = new VmapiApp({
                apiClients: {
                    wfapi: mockedWfapiClient
                },
                changefeedPublisher: changefeedUtils.createNoopCfPublisher(),
                metricsManager: mockedMetricsManager,
                moray: moray,
                morayBucketsInitializer: morayBucketsInitializer
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
                    var expectedStatus = 'OK';
                    var morayInitStatus;
                    var overallHealthy;
                    var overallStatus;

                    if (obj) {
                        morayInitStatus = obj.initialization.moray;
                        overallHealthy = obj.healthy;
                        overallStatus = obj.status;
                    }

                    if (overallStatus === expectedStatus &&
                        overallHealthy === expectedHealthiness &&
                        morayInitStatus.bucketsSetup.state === 'DONE' &&
                        morayInitStatus.bucketsReindex.state === 'ERROR' &&
                        morayInitStatus.bucketsReindex.latestError ===
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

            morayClient.reindexObjects = origMorayReindexObjects;

            function onMockedMorayBucketsInitDone() {
                vmapiClient.ping(function onVmapiPing(pingErr, obj, req, res) {
                    var actualMorayInitStatus = obj.initialization.moray;
                    var expectedMorayReindexStatus = 'DONE';
                    var expectedResponseHttpStatus = 200;

                    t.equal(res.statusCode, expectedResponseHttpStatus,
                        'Response\'s HTTP status code should be ' +
                            expectedResponseHttpStatus);
                    t.equal(pingErr, null, 'ping endpoint should not ' +
                        'error when no error injected in moray ' +
                        'initialization');
                    t.equal(actualMorayInitStatus.bucketsReindex.state,
                        expectedMorayReindexStatus,
                        'Moray initialization status should be: ' +
                            expectedMorayReindexStatus + ' and is: ' +
                            actualMorayInitStatus.bucketsReindex.state);
                    t.equal(actualMorayInitStatus.bucketsReindex.latestError,
                        undefined,
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
