/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
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
var tritonTracer = require('triton-tracer');
var vasync = require('vasync');

var sdc = require('sdc-clients');
var CNAPI = require('./lib/apis/cnapi');
var IMGAPI = require('./lib/apis/imgapi');
var PAPI = require('./lib/apis/papi');
var tritonTracer = require('triton-tracer');
var VmapiApp = require('./lib/vmapi');
var VOLAPI = require('sdc-clients').VOLAPI;
var WFAPI = require('./lib/apis/wfapi');

var configLoader = require('./lib/config-loader');
var createMetricsManager = require('triton-metrics').createMetricsManager;
var DataMigrationsController = require('./lib/data-migrations/controller');
var dataMigrationsLoader = require('./lib/data-migrations/loader');
var morayInit = require('./lib/moray/moray-init.js');

var DATA_MIGRATIONS;
var dataMigrationCtrl;
var morayBucketsInitializer;
var morayClient;
var moray;

var METRICS_SERVER_PORT = 8881;
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
    var dataMigrations;
    var dataMigrationsCtrl;
    var metricsManager;
    var vmapiLog = bunyan.createLogger({
        name: 'vmapi',
        level: config.logLevel,
        serializers: restify.bunyan.serializers
    });

    config.version = version() || '7.0.0';

    // Init tracing now that we have a logger
    tritonTracer.init({
        log: vmapiLog,
        sampling: {
            route: {
                changefeeds: 0.1,
                changefeeds_stats: 0.1,
                ping: 0.1
            }, GET: {
                '/ping': 0.1
            }
        }
    });

    // Increase/decrease loggers levels using SIGUSR2/SIGUSR1:
    sigyan.add([vmapiLog]);

    http.globalAgent.maxSockets = config.maxSockets || 100;
    https.globalAgent.maxSockets = config.maxSockets || 100;

    apiClients = createApiClients(config, vmapiLog);

    vasync.pipeline({funcs: [
        function initTritonTracer(_, next) {
            tritonTracer.init({
                // create this generically and pass in to constructor/config?
                log: new bunyan({
                    name: 'vmapi',
                    level: 'debug'
                })
            }, function (/* session */) {
                // session.set('sessionState', ['server.js:53']);
                vmapi = new VMAPI(config);
                vmapi.init();
            });
        },
        function initChangefeedPublisher(_, next) {
            var changefeedOptions = jsprim.deepCopy(config.changefeed);
            changefeedOptions.log = vmapiLog.child({ component: 'changefeed' },
                true);
            changefeedOptions.log.level(bunyan.WARN);

            changefeedPublisher =
                changefeed.createPublisher(changefeedOptions);

            changefeedPublisher.on('moray-ready', function onMorayReady() {
                changefeedPublisher.start();
                next();
            });
        },
        function loadDataMigrations(_, next) {
            vmapiLog.info('Loading data migrations modules');

            dataMigrationsLoader.loadMigrations({
                log: vmapiLog.child({ component: 'migrations-loader' }, true)
            }, function onMigrationsLoaded(migrationsLoadErr, migrations) {
                if (migrationsLoadErr) {
                    vmapiLog.error({err: migrationsLoadErr},
                            'Error when loading data migrations modules');
                } else {
                    vmapiLog.info({migrations: migrations},
                        'Loaded data migrations modules successfully!');
                }

                dataMigrations = migrations;
                next(migrationsLoadErr);
            });
        },

        function initMoray(_, next) {
            assert.object(changefeedPublisher, 'changefeedPublisher');

            var morayConfig = jsprim.deepCopy(config.moray);
            morayConfig.changefeedPublisher = changefeedPublisher;

            var moraySetup = morayInit.startMorayInit({
                morayConfig: morayConfig,
                log: vmapiLog.child({ component: 'moray-init' }, true),
                changefeedPublisher: changefeedPublisher
            });

            morayBucketsInitializer = moraySetup.morayBucketsInitializer;
            morayClient = moraySetup.morayClient;
            moray = moraySetup.moray;

            /*
             * We don't set an 'error' event listener because we want the
             * process to abort when there's a non-transient data migration
             * error.
             */
            dataMigrationsCtrl = new DataMigrationsController({
                log: vmapiLog.child({
                    component: 'migrations-controller'
                }, true),
                migrations: dataMigrations,
                moray: moray
            });

            /*
             * We purposely start data migrations *only when all buckets are
             * updated and reindexed*. Otherwise, if we we migrated records that
             * have a value for a field for which a new index was just added,
             * moray could discard that field when fetching the object using
             * findObjects or getObject requests (See
             * http://smartos.org/bugview/MORAY-104 and
             * http://smartos.org/bugview/MORAY-428). We could thus migrate
             * those records erroneously, and in the end write bogus data.
             */
            morayBucketsInitializer.on('done',
                function onMorayBucketsInitialized() {
                    dataMigrationsCtrl.start();
                });

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
            metricsManager = createMetricsManager({
                address: config.adminIp,
                log: vmapiLog.child({component: 'metrics'}),
                port: METRICS_SERVER_PORT,
                restify: restify,
                staticLabels: {
                    datacenter: config.datacenterName,
                    instance: config.instanceUuid,
                    server: config.serverUuid,
                    service: config.serviceName
                }
            });

            metricsManager.createRestifyMetrics();
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
            var vmapiOptions = jsprim.mergeObjects(config, {
                apiClients: apiClients,
                changefeedPublisher: changefeedPublisher,
                dataMigrationsCtrl: dataMigrationsCtrl,
                log: vmapiLog.child({ component: 'http-api' }, true),
                metricsManager: metricsManager,
                moray: moray,
                morayBucketsInitializer: morayBucketsInitializer,
                // TODO: These config items should use the same name(s).
                userMigrationAllowed: config.user_migration_allowed,
                zfs_send_mbps_limit: config.migration_send_mbps_limit,
                serverConfig: {
                    bindPort: config.api.port
                }
            });
            var vmapiApp = new VmapiApp(vmapiOptions);

            vmapiApp.listen();
        }
    });
}

startVmapiService();
