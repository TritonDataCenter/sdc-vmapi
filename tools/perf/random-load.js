// Copyright (c) 2013, Joyent, Inc. All rights reserved.

// Backfill image_uuid for KVM VMs
var path = require('path');
var fs = require('fs');
var util = require('util');

var config_file = path.resolve(__dirname, '..', '..', 'config.json');
var bunyan = require('bunyan');
var restify = require('restify');
var async = require('async');
var log;

var VMAPI = require('sdc-clients').VMAPI;
var log = new bunyan({
        name: 'vmapi_load_test',
        level: (process.env.LOG_LEVEL || 'info'),
        serializers: bunyan.stdSerializers
});

var GUINEA_PIG_ALIASES = ['papi0', 'dapi0', 'assets0'];
var GUINEA_PIG_UUIDS = [];
var UUIDS = [];
var uuid, params;

var REQUESTS = [
    // action, probability, needs_params, use_guinea_pigs
    [ 'listVms', 0.25, false ],
    [ 'getVm', 0.60, true ],
    [ 'rebootVm', 0.08, true, true ],
    [ 'snapshotVm', 0.07, true, true ]
];

vmapi = new VMAPI({
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
    setInterval(function () { randomLoad(); }, interval);
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


process.on('SIGINT', function() {
    console.log('Received CTRL-C. Exiting...');
    vmapi.client.close();
});
