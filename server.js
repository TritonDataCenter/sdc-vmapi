/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Main entry-point for the VMs API.
 */

var assert = require('assert-plus');
var backoff = require('backoff');
var fs = require('fs');
var http = require('http');
var https = require('https');
var jsprim = require('jsprim');
var Logger = require('bunyan');
var moray = require('moray');
var path = require('path');
var restify = require('restify');
var sigyan = require('sigyan');
var vasync = require('vasync');

var CNAPI = require('./lib/apis/cnapi');
var IMGAPI = require('./lib/apis/imgapi');
var NAPI = require('./lib/apis/napi');
var PAPI = require('./lib/apis/papi');
var vmapi = require('./lib/vmapi');
var WFAPI = require('./lib/apis/wfapi');

var configLoader = require('./lib/config-loader');
var mod_morayStorage = require('./lib/storage/moray/moray');
var morayBucketsConfig = require('./lib/storage/moray/moray-buckets-config');
var MorayBucketsInitializer =
    require('./lib/storage/moray/moray-buckets-initializer');
var VERSION = false;

/*
 * Returns the current semver version stored in CloudAPI's package.json.
 * This is used to set in the API versioning and in the Server header.
 *
 * @return {String} version.
 */
function version() {
    if (!VERSION) {
        var pkg = fs.readFileSync(__dirname + '/package.json', 'utf8');
        VERSION = JSON.parse(pkg).version;
    }

    return VERSION;
}

/*
 * Creates instances of objects providing abstractions to various Triton APIs
 * that are used by VMAPI. It returns an object of the following form:
 *
 * {
 *   cnapi: cnapiClientInstance,
 *   imgapi: imgapiClientInstance,
 *   ...
 * }
 *
 * with each property named after these APIs, and each value being set to an
 * instance of each corresponding abstraction layer for these APIs.
 */
function createApiClients(config, parentLog) {
    assert.object(config, 'config');
    assert.object(parentLog, 'parentLog');

    assert.object(config.cnapi, 'config.cnapi');
    var cnapiClientOpts = jsprim.deepCopy(config.cnapi);
    cnapiClientOpts.log = parentLog.child({ component: 'cnapi' }, true);
    var cnapiClient = new CNAPI(cnapiClientOpts);

    assert.object(config.imgapi, 'config.imgapi');
    var imgapiClientOpts = jsprim.deepCopy(config.imgapi);
    imgapiClientOpts.log = parentLog.child({ component: 'imgapi' }, true);
    var imgapiClient = new IMGAPI(imgapiClientOpts);

    assert.object(config.napi, 'config.napi');
    var napiClientOpts = jsprim.deepCopy(config.napi);
    napiClientOpts.log = parentLog.child({ component: 'napi' }, true);
    var napiClient = new NAPI(napiClientOpts);

    assert.object(config.papi, 'config.papi');
    var papiClient = new PAPI(config.papi);

    assert.object(config.wfapi, 'config.wfapi');
    var wfapiClientOpts = jsprim.deepCopy(config.wfapi);
    wfapiClientOpts.log = parentLog.child({ component: 'wfapi' }, true);
    var wfapiClient = new WFAPI(wfapiClientOpts);

    return {
        cnapi: cnapiClient,
        imgapi: imgapiClient,
        napi: napiClient,
        papi: papiClient,
        wfapi: wfapiClient
    };
}

/*
 * Creates and returns an object that represents the appropriate options to pass
 * when calling moray.createClient to create an instance of a moray client.
 */
function createMorayClientOpts(config, parentLog) {
    assert.object(config, 'config');
    assert.object(parentLog, 'parentLog');

    assert.object(config.moray, 'config.moray');

    var morayClientOpts = jsprim.deepCopy(config.moray);
    morayClientOpts.log = parentLog.child({ component: 'moray-client' }, true);

    var DEFAULT_MORAY_CONNECTION_RETRY_MIN_TIMEOUT = 1000;
    var morayConnectionMinTimeout = DEFAULT_MORAY_CONNECTION_RETRY_MIN_TIMEOUT;

    var DEFAULT_MORAY_CONNECTION_RETRY_MAX_TIMEOUT = 16000;
    var morayConnectionMaxTimeout = DEFAULT_MORAY_CONNECTION_RETRY_MAX_TIMEOUT;

    if (config.moray.retry && config.moray.retry.minTimeout !== undefined) {
        assert.number(config.moray.retry.minTimeout,
            'config.moray.retry.minTimeout');
        morayConnectionMinTimeout = config.moray.retry.minTimeout;
    }

    if (config.moray.retry && config.moray.retry.maxTimeout !== undefined) {
        assert.number(config.moray.retry.maxTimeout,
            'config.moray.retry.maxTimeout');
        morayConnectionMaxTimeout = config.moray.retry.maxTimeout;
    }

    var morayConnectTimeout;
    if (config.moray.connectTimeout !== undefined) {
        assert.number(config.moray.connectTimeout,
            'config.moray.connectTimeout');
        morayConnectTimeout = config.moray.connectTimeout;
    }

    morayClientOpts.connectTimeout = morayConnectTimeout;

    /*
     * The VMAPI server is meant to stay up regardless of its ability to connect
     * to a moray server so that it can respond to requests on its status
     * endpoint. It should not restart in order to, e.g, retry connecting to a
     * moray server after a certain number of tries. Instead, we setup the moray
     * client to retry connecting to a moray server indefinitely.
     */
    morayClientOpts.retry = {
        retries: Infinity,
        minTimeout: morayConnectionMinTimeout,
        maxTimeout: morayConnectionMaxTimeout
    };

    return morayClientOpts;
}

function startVmapiService() {
    var configFilePath = path.join(__dirname, 'config.json');
    var config = configLoader.loadConfig(configFilePath);
    config.version = version() || '7.0.0';

    var vmapiLog = new Logger({
        name: 'vmapi',
        level: config.logLevel,
        serializers: restify.bunyan.serializers
    });

    // Increase/decrease loggers levels using SIGUSR2/SIGUSR1:
    sigyan.add([vmapi.log]);

    http.globalAgent.maxSockets = config.maxSockets || 100;
    https.globalAgent.maxSockets = config.maxSockets || 100;

    var changefeedOptions = jsprim.deepCopy(config.changefeed);
    changefeedOptions.log =
        vmapiLog.child({ component: 'changefeed' }, true);

    var morayClientOpts = createMorayClientOpts(config, vmapiLog);
    var morayClient;

    var apiClients = createApiClients(config, vmapiLog);

    vasync.parallel({funcs: [
        function connectToMoray(done) {
            morayClient = moray.createClient(morayClientOpts);

            morayClient.on('connect', function onMorayClientConnected() {
                done();
            });

            morayClient.on('error', function onMorayClientConnectionError(err) {
                /*
                 * The current semantics of the underlying node-moray client
                 * connection means that it can emit 'error' events for errors
                 * that the client can actually recover from and that don't
                 * prevent it from establishing a connection. See MORAY-309 for
                 * more info.
                 *
                 * Since in the case of the VMAPI server, we want to retry
                 * establishing a connection indefinitely, this 'error' event
                 * handler should not do anything, but it needs to be added so
                 * that the process doesn't exit due to an unhandled error
                 * event.
                 */
            });
        },
        apiClients.wfapi.connect.bind(apiClients.wfapi)
    ]}, function dependenciesInitDone(err) {
        if (err) {
            vmapi.log.error({
                error: err
            }, 'failed to initialize VMAPI\'s dependencies');

            morayClient.close();
        } else {
            var morayStorage = new mod_morayStorage(morayClient);

            var morayBucketsInitializer =
                new MorayBucketsInitializer({
                    log: vmapiLog.child({
                        component: 'moray-buckets-initializer'
                    }, true)
                });
            morayBucketsInitializer.start(morayStorage, morayBucketsConfig);

            /*
             * We don't want to wait for the storage layer to be ready before
             * creating the HTTP server that will provide VMAPI's API endpoints,
             * as:
             *
             * 1. some endpoints can function properly without using storage.
             *
             * 2. some endpoints are needed to provide status information,
             * including status information about the storage layer.
             */
            var vmapiService = new vmapi({
                version: config.version,
                log: vmapiLog.child({ component: 'http-api' }, true),
                serverConfig: {
                    bindPort: config.api.port
                },
                apiClients: apiClients,
                storage: morayStorage,
                changefeed: changefeedOptions,
                overlay: config.overlay,
                reserveKvmStorage: config.reserveKvmStorage
            });

            vmapiService.init(function onVmapiInitialized() {
                vmapiService.listen();
            });
        }
    });
}

startVmapiService();
