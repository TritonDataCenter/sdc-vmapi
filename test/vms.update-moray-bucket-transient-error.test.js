/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * This test is about making sure that, when a transient error is encountered by
 * the moray buckets setup process, the process is retried until that error is
 * resolved and that, in the meantime, VMAPI's /ping endpoint responds with the
 * proper status error.
 */

var assert = require('assert-plus');
var jsprim = require('jsprim');
var Logger = require('bunyan');
var moray = require('moray');
var path = require('path');
var restify = require('restify');
var vasync = require('vasync');
var mod_vmapiClient = require('sdc-clients').VMAPI;

var configLoader = require('..//lib/config-loader');
var morayStorage = require('../lib/storage/moray/moray');
var morayBucketsConfig = require('../lib/storage/moray/moray-buckets-config');
var MorayBucketsInitializer =
    require('../lib/storage/moray/moray-buckets-initializer');
var vmapi = require('../lib/vmapi');

var configFilePath = path.join(__dirname, '../config.json');
var config = configLoader.loadConfig(configFilePath);

var TRANSIENT_ERROR_MSG = 'Mocked transient error';

exports.moray_init_transient_error = function (t) {
    var morayClient;
    var mockedMorayStorage;
    var morayBucketsInitializer;
    var origMorayClientGetBucket;

    var mockedWfapiClient = {
        connected: true,
        connect: function mockedWfapiConnect(callback) {
            callback();
        }
    };

    var vmapiService;
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
            origMorayClientGetBucket = morayClient.getBucket;

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
            mockedMorayStorage = new morayStorage(morayClient);

            morayBucketsInitializer =
                new MorayBucketsInitializer();

             vmapiService = new vmapi({
                apiClients: {
                    wfapi: mockedWfapiClient
                },
                storage: mockedMorayStorage
            });

            vmapiService.init(next);
        },
        function listenOnVmapiServer(arg, next) {
            vmapiService.listen({
                port: 0
            }, function onVmapiListen() {
                var vmapiServerAddress = vmapiService.server.address();
                var vmapiServerUrl = 'http://' + vmapiServerAddress.address +
                    ':' + vmapiServerAddress.port;

                vmapiClient = new mod_vmapiClient({
                    url: vmapiServerUrl
                });

                next();
            });
        },
        function initMorayWithTransientError(arg, next) {
            /*
             * Monkey patch moray client's getBucket method to inject a
             * transient error, so that we can test that the moray initializer
             * and the VMAPI API behave correctly in that case.
             */
            morayClient.getBucket =
                function mockedGetBucket(bucketName, callback) {
                    callback(new Error(TRANSIENT_ERROR_MSG));
                };

            morayBucketsInitializer.start(mockedMorayStorage,
                morayBucketsConfig);

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
                MorayBucketsInitializer.removeAllListeners('done');
            }

            next();
        },
        function checkMorayStatusWithTransientErr(arg, next) {
            var nbVmapiStatusCheckSoFar = 0;
            var MAX_NB_VMAPI_STATUS_CHECKS = 10;
            var VMAPI_STATUS_CHECKS_DELAY = 1000;

            function checkPingTransientErr(callback) {
                vmapiClient.ping(function onVmapiPing(pingErr, obj) {
                    var errBody = pingErr.body;
                    var expectedStatus = 'some services are not ready';
                    var expectedHealthiness = false;
                    var expectedErrString = 'Error: ' + TRANSIENT_ERROR_MSG;

                    if (errBody.status === expectedStatus &&
                        errBody.healthy === expectedHealthiness &&
                        errBody.services.moray.initialization.error ===
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
                                'expected  status');
                            next();
                        }
                    }

                    checkPingTransientErr(transientErrChecked);
                } else {
                    t.ok(false, 'Status endpoint did not respond with ' +
                        'expected  status');
                    next();
                }
            }

            scheduleVmapiCheckTransientErr();
        },
        function listVmsWithMorayTransientErr(arg, next) {
            vmapiClient.listVms({
                limit: 1
            }, function onListVms(listVmsErr, vms) {
                var listVmsErrMsg;

                if (listVmsErr) {
                    listVmsErrMsg = listVmsErr.toString();
                }

                t.ok(listVmsErr,
                    'listing VMs when moray not initialized should error');
                t.notEqual(listVmsErrMsg.indexOf(TRANSIENT_ERROR_MSG), -1,
                    'error message should include "' + TRANSIENT_ERROR_MSG +
                        '"');

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

            morayBucketsInitializer.once('done', onMockedMorayBucketsSetup);
            morayBucketsInitializer.once('error',
                onMockedMorayBucketsSetupFailed);

            morayClient.getBucket = origMorayClientGetBucket;

            function onMockedMorayBucketsSetup() {
                vmapiClient.ping(function onVmapiPing(pingErr, obj) {
                    t.equal(pingErr, null, 'ping endpoint should not ' +
                        'error when no error injected in moray ' +
                        'initialization');
                    morayBucketsInitializer.removeAllListeners('error');
                    next();
                });
            }

            function onMockedMorayBucketsSetupFailed(morayBucketsSetupErr) {
                t.equal(morayBucketsSetupErr, undefined,
                    'moray buckets setup should be successful');
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
        vmapiService.close();
        morayClient.close();

        t.done();
    });
};
