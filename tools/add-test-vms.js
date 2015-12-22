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
 * $ LOG_LEVEL=trace node tools/add-test-vms.js [nb_test_vms_to_create]
 * [concurrency]
 */

var path = require('path');
var fs = require('fs');

var libuuid = require('libuuid');
var bunyan = require('bunyan');
var restify = require('restify');
var assert = require('assert-plus');

var testCommon = require('../test/lib/vm');

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

var moray = new MORAY(config.moray);

moray.connect();
moray.once('moray-ready', function () {
    log.debug('Morary ready!');

    var nbTestVmsToCreate = Number(process.argv[2]) ||
        DEFAULT_NB_TEST_VMS_TO_CREATE;
    log.debug('Number of test VMs to create:', nbTestVmsToCreate);
    assert.number(nbTestVmsToCreate);

    var concurrency = Number(process.argv[3]) || DEFAULT_CONCURRENCY;
    log.debug('concurrency:', concurrency);
    assert.number(concurrency);

    testCommon.createTestVMs(nbTestVmsToCreate, moray, {
        concurrency: concurrency,
        log: log
    }, {}, function allVmsCreated(err) {
        if (err) {
            log.error({err: err}, 'Error when creating test VMs');
        } else {
            log.info('All VMs created successfully');
        }

        log.debug('Closing moray connection');
        moray.connection.close();
    });
});
