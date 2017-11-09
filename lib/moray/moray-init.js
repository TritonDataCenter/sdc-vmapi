/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * This module is a helper module aimed at making initializing the Moray
 * database layer a bit easier than having to use the several different
 * subsystems involved: a moray client, an instance of lib/apis/moray.js, and a
 * MorayBucketsInitializer. Instead, it exports one function, "startMorayInit",
 * that can be called to perform all of the steps required.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var jsprim = require('jsprim');
var mod_moray = require('moray');
var restify = require('restify');

var Moray = require('../apis/moray');
var MorayBucketsInitializer = require('./moray-buckets-initializer.js');
var DEFAULT_MORAY_BUCKETS_CONFIG = require('./moray-buckets-config.js');

/*
 * Starts the initialization of the moray storage layer and returns an object
 * with the following properties:
 *
 * - morayBucketsInitializer: the instance of MorayBucketsInitializer that will
 * be used to initialize moray buckets. Event listeners for the 'ready' and
 * 'error' events can be setup on this instance to run code when the moray
 * buckets have been initialized, or when an unrecoverable error (including
 * reaching the maximum number of retries) has occured.
 *
 * - moray: the instance of Moray that will be used to perform operations on
 * VMAPI's Moray buckets as part of the initialization process.
 *
 * - morayClient: the instance of MorayClient that will be used to connect to
 * the Moray service.
 *
 * Parameters:
 *
 * - "options":
 *
 * - "options.morayConfig": an object that represents the settings to use to
 *   connect to a moray server.
 *
 * - "options.maxBucketsSetupAttempts": the maximum number of attempts to be
 *   used by the MorayBucketsInitializer instance that is driving the moray
 *   buckets setup (creating and updating buckets, but not reindexing them)
 *   process. If undefined, the MorayBucketsInitializer will retry indefinitely.
 *
 * - "options.maxBucketsReindexAttempts": the maximum number of attempts to be
 *   used by the MorayBucketsInitializer instance that is driving the moray
 *   buckets reindexing (not creating and updating buckets, just reindexing
 *   them) process. If undefined, the MorayBucketsInitializer will retry
 *   indefinitely.
 *
 * - "options.morayBucketsConfig": an object describing the moray buckets
 * configuration. If not provided, the default moray buckets configuration used
 * by VMAPI for its normal operation will be used.
 *
 * - "options.changefeedPublisher" (mandatory): the instance of changefeed
 * publisher to pass to the underlying moray storage layer.
 *
 * - "options.log": a bunyan logger object to use to log messages. If not
 * provided, one will be created with the name "moray-init".
 *
 * Errors related to the moray client are ignored because the moray client is
 * not set in the "failfast" mode. That means it will retry indefinitely and not
 * emit any 'error' event.
 *
 * Errors related to the moray buckets initialization process are emitted on the
 * MorayBucketsInitializer instance that is returned.
 *
 * Here's how the initialization process is broken down:
 *
 * 1. Creating a node-moray client instance and using it to connect to a moray
 * server according to the settings found in "morayConfig".
 *
 * 2. Creating a Moray instance associated with that client.
 *
 * 3. Creating a MorayBucketsInitializer instance associated to that Moray
 * instance and starting initializing moray buckets.
 */
function startMorayInit(options) {
    assert.optionalObject(options, 'options');

    options = options || {};

    assert.object(options.morayConfig, 'options.morayConfig');
    assert.optionalObject(options.log, 'options.log');
    assert.optionalNumber(options.maxBucketsReindexAttempts,
        'options.maxBucketsReindexAttempts');
    assert.optionalNumber(options.maxBucketsSetupAttempts,
        'options.maxBucketsSetupAttempts');
    assert.optionalObject(options.morayBucketsConfig,
        'options.morayBucketsConfig');
    assert.object(options.changefeedPublisher, 'options.changefeedPublisher');

    var changefeedPublisher = options.changefeedPublisher;
    var log = options.log;
    var maxBucketsReindexAttempts = options.maxBucketsReindexAttempts;
    var maxBucketsSetupAttempts = options.maxBucketsSetupAttempts;
    var moray;
    var morayBucketsConfig = options.morayBucketsConfig ||
        DEFAULT_MORAY_BUCKETS_CONFIG;
    var morayBucketsInitializerLog;
    var morayClient;
    var morayClientLogger = bunyan.createLogger({
        name: 'moray-client',
        level: 'info',
        serializers: restify.bunyan.serializers
    });
    var morayConfig = jsprim.deepCopy(options.morayConfig);
    var morayStorageLog;

    morayConfig.log = morayClientLogger;
    morayClient = mod_moray.createClient(morayConfig);

    if (log === undefined) {
        log = bunyan.createLogger({
            name: 'moray-init',
            level: 'info',
            serializers: restify.bunyan.serializers
        });
    }

    morayStorageLog = log.child({
        component: 'moray'
    }, true);

    morayBucketsInitializerLog = log.child({
        component: 'moray-buckets-initializer'
    }, true);

    moray = new Moray({
        changefeedPublisher: changefeedPublisher,
        bucketsConfig: morayBucketsConfig,
        morayClient: morayClient,
        log: morayStorageLog
    });

    var morayBucketsInitializer = new MorayBucketsInitializer({
        maxBucketsSetupAttempts: maxBucketsSetupAttempts,
        maxBucketsReindexAttempts: maxBucketsReindexAttempts,
        log: morayBucketsInitializerLog
    });

    morayClient.on('connect', function onMorayClientConnected() {
        morayBucketsInitializer.start(moray);
    });

    return {
        morayBucketsInitializer: morayBucketsInitializer,
        moray: moray,
        morayClient: morayClient
    };
}

exports.startMorayInit = startMorayInit;