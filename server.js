/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * Main entry-point for the VMs API.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var changefeed = require('changefeed');
var cueball = require('cueball');
var fs = require('fs');
var http = require('http');
var https = require('https');
var jsprim = require('jsprim');
var path = require('path');
var restify = require('restify');
var sigyan = require('sigyan');
var util = require('util');
var vasync = require('vasync');

var sdc = require('sdc-clients');
var CNAPI = require('./lib/apis/cnapi');
var IMGAPI = require('./lib/apis/imgapi');
var PAPI = require('./lib/apis/papi');
var VmapiApp = require('./lib/vmapi');
var VOLAPI = require('sdc-clients').VOLAPI;
var WFAPI = require('./lib/apis/wfapi');

var configLoader = require('./lib/config-loader');
var createMetricsManager = require('./lib/metrics').createMetricsManager;
var morayInit = require('./lib/moray/moray-init.js');

var DATA_MIGRATIONS;
var dataMigrationCtrl;
var morayBucketsInitializer;
var morayClient;
var moray;

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

    var agent;
    if (config.cueballHttpAgent) {
        agent = new cueball.HttpAgent(config.cueballHttpAgent);
    }

    assert.object(config.cnapi, 'config.cnapi');
    var cnapiClientOpts = jsprim.deepCopy(config.cnapi);
    cnapiClientOpts.log = parentLog.child({ component: 'cnapi' }, true);
    cnapiClientOpts.agent = agent;
    var cnapiClient = new CNAPI(cnapiClientOpts);

    assert.object(config.imgapi, 'config.imgapi');
    var imgapiClientOpts = jsprim.deepCopy(config.imgapi);
    imgapiClientOpts.log = parentLog.child({ component: 'imgapi' }, true);
    imgapiClientOpts.agent = agent;
    var imgapiClient = new IMGAPI(imgapiClientOpts);

    assert.object(config.napi, 'config.napi');
    var napiLog = parentLog.child({ component: 'napi' }, true);
    var napiClient = new sdc.NAPI({
        log: napiLog,
        url: config.napi.url,
        agent: agent
    });

    assert.object(config.papi, 'config.papi');
    var papiClientOpts = jsprim.deepCopy(config.papi);
    papiClientOpts.log = parentLog.child({ component: 'papi' }, true);
    papiClientOpts.agent = agent;
    var papiClient = new PAPI(papiClientOpts);

    assert.object(config.volapi, 'config.volapi');
    var volapiClientOpts = jsprim.deepCopy(config.volapi);
    var volapiClient = new VOLAPI({
        agent: agent,
        url: volapiClientOpts.url,
        userAgent: 'sdc-vmapi'
    });

    assert.object(config.wfapi, 'config.wfapi');
    var wfapiClientOpts = jsprim.deepCopy(config.wfapi);
    wfapiClientOpts.log = parentLog.child({ component: 'wfapi' }, true);
    wfapiClientOpts.agent = agent;
    var wfapiClient = new WFAPI(wfapiClientOpts);

    return {
        cnapi: cnapiClient,
        imgapi: imgapiClient,
        napi: napiClient,
        papi: papiClient,
        volapi: volapiClient,
        wfapi: wfapiClient
    };
}

function startVmapiService() {
    var apiClients;
    var changefeedPublisher;
    var configFilePath = path.join(__dirname, 'config.json');
    var config = configLoader.loadConfig(configFilePath);
    var metricsManager;
    var vmapiLog = bunyan.createLogger({
        name: 'vmapi',
        level: config.logLevel,
        serializers: restify.bunyan.serializers
    });

    config.version = version() || '7.0.0';

    // Increase/decrease loggers levels using SIGUSR2/SIGUSR1:
    sigyan.add([vmapiLog]);

    http.globalAgent.maxSockets = config.maxSockets || 100;
    https.globalAgent.maxSockets = config.maxSockets || 100;

    apiClients = createApiClients(config, vmapiLog);

    vasync.pipeline({funcs: [
        function initChangefeedPublisher(_, next) {
            var changefeedOptions = jsprim.deepCopy(config.changefeed);
            changefeedOptions.log = vmapiLog.child({ component: 'changefeed' },
                true);

            changefeedPublisher =
                changefeed.createPublisher(changefeedOptions);

            changefeedPublisher.on('moray-ready', function onMorayReady() {
                changefeedPublisher.start();
                next();
            });
        },

        function initMoray(_, next) {
            assert.object(changefeedPublisher, 'changefeedPublisher');

            var morayConfig = jsprim.deepCopy(config.moray);
            morayConfig.changefeedPublisher = changefeedPublisher;

            var moraySetup = morayInit.startMorayInit({
                changefeedPublisher: changefeedPublisher,
                dataMigrationsPath: path.join(__dirname, 'lib',
                    'data-migrations', 'migrations'),
                log: vmapiLog.child({ component: 'moray-init' }, true),
                morayConfig: morayConfig
            });

            morayBucketsInitializer = moraySetup.morayBucketsInitializer;
            morayClient = moraySetup.morayClient;
            moray = moraySetup.moray;

            /*
             * We don't want to wait for the Moray initialization process to be
             * done before creating the HTTP server that will provide VMAPI's
             * API endpoints, as:
             *
             * 1. some endpoints can function properly without using the Moray
             *    storage layer.
             *
             * 2. some endpoints are needed to provide status information,
             *    including status information about the storage layer.
             */
            next();
        },
        function connectToWfApi(_, next) {
            apiClients.wfapi.connect();
            /*
             * We intentionally don't need and want to wait for the Workflow API
             * client to be connected before continuing the process of standing
             * up VMAPI. Individual request handlers will handle the Workflow
             * API client's connection status appropriately and differently.
             */
            next();
        },
        function createMetricsCollector(_, next) {
            var metricsLog = vmapiLog.child({component: 'metrics'});

            var metricsConfig = {
                address: config.adminIp,
                log: metricsLog,
                labels: {
                    datacenter: config.datacenterName,
                    instance: config.instanceUuid,
                    server: config.serverUuid,
                    service: config.serviceName
                },
                port: 8881
            };

            metricsManager = createMetricsManager(metricsConfig);
            metricsManager.listen(function metricsServerStarted() {
                next();
            });
        }
    ]}, function dependenciesInitDone(err) {
        if (err) {
            vmapiLog.error({
                error: err
            }, 'failed to initialize VMAPI\'s dependencies');

            if (changefeedPublisher) {
                changefeedPublisher.stop();
            }

            if (morayClient) {
                morayClient.close();
            }

            process.exitCode = 1;
        } else {
            var vmapiApp = new VmapiApp({
                apiClients: apiClients,
                changefeedPublisher: changefeedPublisher,
                log: vmapiLog.child({ component: 'http-api' }, true),
                metricsManager: metricsManager,
                moray: moray,
                morayBucketsInitializer: morayBucketsInitializer,
                overlay: config.overlay,
                reserveKvmStorage: config.reserveKvmStorage,
                serverConfig: {
                    bindPort: config.api.port
                },
                version: config.version
            });

            vmapiApp.listen();
        }
    });
}

startVmapiService();
