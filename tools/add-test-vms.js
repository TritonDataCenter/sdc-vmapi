#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * This script is a tool to add test VM entries in Moray. It will create fake
 * VMs with the value 'test--' for the 'alias' property.
 * You can specify the trace log level, the number of VMs to create and the
 * number of VMs created concurrently on the command line like following:
 *
 * Run node add-test-vms.js -h for usage.
 */

var path = require('path');
var fs = require('fs');

var dashdash = require('dashdash');
var libuuid = require('libuuid');
var bunyan = require('bunyan');
var restify = require('restify');
var assert = require('assert-plus');

var testVm = require('../test/lib/vm');
var configFileLoader = require('../lib/config-loader');
var MORAY = require('../lib/apis/moray');

var DEFAULT_NB_TEST_VMS_TO_CREATE = 60;
var DEFAULT_CONCURRENCY = 10;

var configFilePath = path.join(__dirname, '..', 'config.json');
var config = configFileLoader.loadConfig(configFilePath);

log = this.log = new bunyan({
    name: 'add-test-vms',
    level: process.env.LOG_LEVEL || config.logLevel || 'debug',
    serializers: restify.bunyan.serializers
});

config.moray.reconnect = true;
var moray = new MORAY(config.moray);

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
    data = data || {};

    moray.connect();
    moray.once('moray-ready', function () {
        log.debug('Moray ready!');

        log.debug('Number of test VMs to create:', nbTestVmsToCreate);
        assert.finite(nbTestVmsToCreate);

        log.debug('concurrency:', concurrency);
        assert.finite(concurrency);

        testVm.createTestVMs(nbTestVmsToCreate, moray, {
            concurrency: concurrency,
            log: log
        }, data, function allVmsCreated(err) {
            if (err) {
                log.error({err: err}, 'Error when creating test VMs');
            } else {
                log.info('All VMs created successfully');
            }

            log.debug('Closing moray connection');
            moray.connection.close();
        });
    });
}

var cmdlineOptionsParser = dashdash.createParser({options: cmdlineOptions});
var nbTestVmsToCreate;
var concurrency;
var testVmsData;
var parsedCmdlineOpts;

try {
    parsedCmdlineOpts = cmdlineOptionsParser.parse(process.argv);

    if (parsedCmdlineOpts.help) {
        printUsage(cmdlineOptionsParser);
    } else {
        nbTestVmsToCreate = Number(parsedCmdlineOpts.n) ||
            DEFAULT_NB_TEST_VMS_TO_CREATE;

        concurrency = Number(parsedCmdlineOpts.c) ||
            DEFAULT_CONCURRENCY;

        if (parsedCmdlineOpts.d) {
            testVmsData = JSON.parse(parsedCmdlineOpts.d);
        }

        addTestVms(nbTestVmsToCreate, concurrency, testVmsData);
    }
} catch (err) {
    console.error('Could not parse command line options');
    printUsage(cmdlineOptionsParser);
    process.exit(1);
}
