#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * This script is a tool to add test VM entries in Moray. It will create fake
 * VMs with the value 'test--' for the 'alias' property.
 * You can specify the trace log level, the number of VMs to create and the
 * number of VMs created concurrently on the command line like following:
 *
 * Run node add-test-vms.js -h for usage.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var dashdash = require('dashdash');
var fs = require('fs');
var jsprim = require('jsprim');
var moray = require('moray');
var libuuid = require('libuuid');
var path = require('path');
var restify = require('restify');

var testVm = require('../test/lib/vm');
var configFileLoader = require('../lib/config-loader');
var mod_morayStorage = require('../lib/storage/moray/moray');
var morayBucketsConfig = require('../lib/storage/moray/moray-buckets-config');

var DEFAULT_NB_TEST_VMS_TO_CREATE = 60;
var DEFAULT_CONCURRENCY = 10;

var configFilePath = path.join(__dirname, '..', 'config.json');
var config = configFileLoader.loadConfig(configFilePath);

var log = this.log = new bunyan({
    name: 'add-test-vms',
    level: process.env.LOG_LEVEL || config.logLevel || 'debug',
    serializers: restify.bunyan.serializers
});

var cmdlineOptions = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Print this help and exit'
    },
    {
        names: ['n'],
        type: 'positiveInteger',
        help: 'Number of test VMs to create'
    },
    {
        names: ['d'],
        type: 'string',
        help: 'JSON string representing the data used to create every test VMs.'
    },
    {
        names: ['c'],
        type: 'positiveInteger',
        help: 'The number of VMs added concurrently'
    }
];

function printUsage(cmdLineOptionsParser) {
    var help = cmdlineOptionsParser.help({includeEnv: true}).trimRight();
    console.log('usage: node add-test-vms.js [OPTIONS]\n' +
        'options:\n' + help);
}

function addTestVms(nbVms, concurrency, data) {
    assert.number(nbVms, 'nbVms must be a number');
    assert.ok(nbVms > 0, 'nbVms must be a positive number');

    assert.number(concurrency, 'concurrency must be a number');
    assert.ok(concurrency > 0, 'concurrency must be a positive number');

    assert.optionalObject(data, 'data must be an optional object');
    data = data || {};

    var morayClientConfig = jsprim.deepCopy(config.moray);
    morayClientConfig.log = log.child({component: 'moray-client'}, true);

    var morayClient = moray.createClient(morayClientConfig);
    var morayStorage = new mod_morayStorage({
            morayClient: morayClient
        });

    morayClient.on('connect', function onMorayClientConnected() {

        morayStorage.setupBuckets(morayBucketsConfig,
            function onMorayBucketsSetup(morayBucketsSetupErr) {
                if (morayBucketsSetupErr) {
                    log.error({error: morayBucketsSetupErr},
                        'Error when setting up moray buckets');
                    morayClient.close();
                    process.exitCode = 1;
                } else {
                    onMorayStorageReady();
                }
            });
    });

    morayClient.on('error', function onMorayClientConnectionError(err) {
        /*
         * The current semantics of the underlying node-moray client
         * connection means that it can emit 'error' events for errors
         * that the client can actually recover from and that don't
         * prevent it from establishing a connection. See MORAY-309 for
         * more info.
         */
    });

    function onMorayStorageReady() {
        log.debug('Number of test VMs to create:', nbVms);
        assert.number(nbVms);

        log.debug('concurrency:', concurrency);
        assert.number(concurrency);

        testVm.createTestVMs(nbVms, morayStorage, {
            concurrency: concurrency,
            log: log
        }, data, function allVmsCreated(err) {
            if (err) {
                log.error({err: err}, 'Error when creating test VMs');
            } else {
                log.info('All VMs created successfully');
            }

            log.debug('Closing moray connection');
            morayClient.close();
        });
    }
}

var cmdlineOptionsParser = dashdash.createParser({options: cmdlineOptions});
var nbVmsParam;
var concurrencyParam;
var vmsDataParam;
var parsedCmdlineOpts;

try {
    parsedCmdlineOpts = cmdlineOptionsParser.parse(process.argv);

    if (parsedCmdlineOpts.help) {
        printUsage(cmdlineOptionsParser);
    } else {
        nbVmsParam = Number(parsedCmdlineOpts.n) ||
            DEFAULT_NB_TEST_VMS_TO_CREATE;

        concurrencyParam = Number(parsedCmdlineOpts.c) ||
            DEFAULT_CONCURRENCY;

        if (parsedCmdlineOpts.d) {
            vmsDataParam = JSON.parse(parsedCmdlineOpts.d);
        }

        addTestVms(nbVmsParam, concurrencyParam, vmsDataParam);
    }
} catch (err) {
    console.error('Could not parse command line options');
    printUsage(cmdlineOptionsParser);
    process.exit(1);
}
