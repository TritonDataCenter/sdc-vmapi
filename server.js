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
var fs = require('fs');
var http = require('http');
var https = require('https');
var jsprim = require('jsprim');
var Logger = require('bunyan');
var path = require('path');
var restify = require('restify');
var sigyan = require('sigyan');
var vasync = require('vasync');

var CNAPI = require('./lib/apis/cnapi');
var IMGAPI = require('./lib/apis/imgapi');
var MORAY = require('./lib/apis/moray');
var NAPI = require('./lib/apis/napi');
var PAPI = require('./lib/apis/papi');
var vmapi = require('./lib/vmapi');
var WFAPI = require('./lib/apis/wfapi');

var configLoader = require('./lib/config-loader');
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
    var papiClientOpts = jsprim.deepCopy(config.papi);
    papiClientOpts.log = parentLog.child({ component: 'papi' }, true);
    var papiClient = new PAPI(papiClientOpts);

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

    var morayApi = new MORAY(config.moray);

    var apiClients = createApiClients(config, vmapiLog);

    vasync.parallel({funcs: [
        function connectToMoray(done) {
            morayApi.connect();

            morayApi.on('moray-ready', function onMorayReady() {
                done();
            });
        },
        function connectToWfApi(done) {
            apiClients.wfapi.connect();
            /*
             * We intentionally don't need and want to wait for the Workflow API
             * client to be connected before continuing the process of standing
             * up VMAPI. Individual request handlers will handle the Workflow
             * API client's connection status appropriately and differently.
             */
            done();
        }
    ]}, function dependenciesInitDone(err) {
        if (err) {
            vmapiLog.error({
                error: err
            }, 'failed to initialize VMAPI\'s dependencies');

            morayApi.close();
        } else {
            var vmapiService = new vmapi({
                version: config.version,
                log: vmapiLog.child({ component: 'http-api' }, true),
                serverConfig: {
                    bindPort: config.api.port
                },
                apiClients: apiClients,
                moray: morayApi,
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
