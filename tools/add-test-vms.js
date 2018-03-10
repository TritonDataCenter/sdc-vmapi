#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
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
var libuuid = require('libuuid');
var path = require('path');
var restify = require('restify');

var changefeedUtils = require('../lib/changefeed');
var configFileLoader = require('../lib/config-loader');
var morayInit = require('../lib/moray/moray-init');
var testVm = require('../test/lib/vm');

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
    assert.finite(nbVms, 'nbVms must be a number');
    assert.ok(nbVms > 0, 'nbVms must be a positive number');

    assert.finite(concurrency, 'concurrency must be a number');
    assert.ok(concurrency > 0, 'concurrency must be a positive number');

    assert.optionalObject(data, 'data must be an optional object');
    var morayConfig = jsprim.deepCopy(config.moray);

    morayConfig.reconnect = true;

    data = data || {};

    var morayClient;
    var moray;
    var morayBucketsInitializer;
    var moraySetup = morayInit.startMorayInit({
        morayConfig: morayConfig,
        maxBucketsReindexAttempts: 1,
        maxBucketsSetupAttempts: 1,
        changefeedPublisher: changefeedUtils.createNoopCfPublisher()
    });

    morayClient = moraySetup.morayClient;
    moray = moraySetup.moray;
    morayBucketsInitializer = moraySetup.morayBucketsInitializer;

    morayBucketsInitializer.on('buckets-setup-done',
        function onMorayBucketsSetup() {
            log.debug('Number of test VMs to create:', nbVms);
            assert.number(nbVms);

            log.debug('concurrency:', concurrency);
            assert.number(concurrency);

            testVm.createTestVMs(nbVms, moray, {
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
        });
}

var cmdlineOptionsParser = dashdash.createParser({options: cmdlineOptions});
var concurrencyParam;
var nbVmsParam;
var parsedCmdlineOpts;
var vmsDataParam;

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
    }
} catch (err) {
    console.error('Could not parse command line options, error:', err);
    printUsage(cmdlineOptionsParser);
    process.exit(1);
}

addTestVms(nbVmsParam, concurrencyParam, vmsDataParam);
