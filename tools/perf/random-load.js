/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

// Backfill image_uuid for KVM VMs
var path = require('path');
var fs = require('fs');
var util = require('util');

var config_file = path.resolve(__dirname, '..', '..', 'config.json');
var bunyan = require('bunyan');
var restify = require('restify');
var async = require('async');

var VMAPI = require('sdc-clients').VMAPI;
var log = new bunyan({
        name: 'vmapi_load_test',
        level: (process.env.LOG_LEVEL || 'info'),
        serializers: bunyan.stdSerializers
});

var GUINEA_PIG_ALIASES = ['papi0', 'dapi0', 'assets0'];
var GUINEA_PIG_UUIDS = [];
var periodicLoad;
var UUIDS = [];
var uuid, params;

var REQUESTS = [
    // action, probability, needs_params, use_guinea_pigs
    [ 'listVms', 0.25, false ],
    [ 'getVm', 0.60, true ],
    [ 'rebootVm', 0.08, true, true ],
    [ 'snapshotVm', 0.07, true, true ]
];

var vmapi = new VMAPI({
    url: 'localhost',
    retry: {
        retries: 1,
        minTimeout: 1000
    },
    log: log,
    agent: false
});

vmapi.listVms({ 'tag.smartdc_type': 'core' }, function (err, vms) {
    log.info('Found %d core VMs', vms.length);

    var vm;
    for (var i = 0; i < vms.length; i++) {
        vm = vms[i];
        if (GUINEA_PIG_ALIASES.indexOf(vm.alias) !== -1) {
            GUINEA_PIG_UUIDS.push(vm.uuid);
        }
        UUIDS.push(vm.uuid);
    }

    // Careful :)
    var interval = process.env.LOAD_INTERVAL || 3000;
    periodicLoad = setInterval(function () { randomLoad(); }, interval);
});


function shouldFire(req) {
    return Math.random() < req[1];
}


function randomId(array) {
    return array[Math.floor(Math.random() * array.length)];
}


function randomLoad() {
    var req = REQUESTS[Math.floor(Math.random() * REQUESTS.length)];

    if (!shouldFire(req))
        return randomLoad();

    // req[2] specifies if we need params
    if (req[2] === true) {
        // req[3] specifies if we want to call an expensive action
        uuid = (req[3] === true) ? randomId(GUINEA_PIG_UUIDS)
                                           : randomId(UUIDS);
        return vmapi[req[0]].call(vmapi, { uuid: uuid }, callback);
    } else {
        return vmapi[req[0]].call(vmapi, callback);
    }

    function callback(err) {
        if (err) {
            log.error('Could not process %s: %s', req[0], err.toString());
        } else {
            if (req[2] === true) {
                log.info('%s ran successfully for %s', req[0], uuid);
            } else {
                log.info('%s ran successfully', req[0]);
            }
        }
    }
}


process.on('SIGINT', function onSigInt() {
    console.log('Received CTRL-C. Exiting...');
    vmapi.client.close();
    clearInterval(periodicLoad);
});


function drainStdoutAndExit(code) {
    var stdoutFlushed = process.stdout.write('');
    if (stdoutFlushed) {
        process.exit(code);
    } else {
        process.stdout.on('drain', function () {
            process.exit(code);
        });
    }
}


process.stdout.on('error', function (err) {
    if (err.code === 'EPIPE') {
        // See <https://github.com/trentm/json/issues/9>.
        process.exit(0);
        /**
         * ^^^ A hard exit here means that stderr won't get drained, which
         * might mean some missing logging. However, attempting
         *      drainStdoutAndExit(0);
         * is proving difficult -- getting repeated "Error: This socket is
         * closed." on write attempts to stdout leading to "RangeError:
         * Maximum call stack size exceeded"
         */
    } else {
        console.warn('mill error: stdout (%s): %s', err.code, err);
        drainStdoutAndExit(1);
    }
});
