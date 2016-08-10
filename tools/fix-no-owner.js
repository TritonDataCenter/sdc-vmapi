/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

// Backfill image_uuid for KVM VMs
var async = require('async');
var bunyan = require('bunyan');
var path = require('path');
var fs = require('fs');
var jsprim = require('jsprim');
var moray = require('moray');
var restify = require('restify');
var util = require('util');

var common = require('../lib/common');
var configLoader = require('../lib/config-loader');
var mod_morayStorage = require('../lib/storage/moray/moray');
var morayBucketsConfig = require('../lib/storage/moray/moray-buckets-config');
var WFAPI = require('../lib/apis/wfapi');

var levels = [bunyan.TRACE, bunyan.DEBUG, bunyan.INFO,
              bunyan.WARN, bunyan.ERROR, bunyan.FATAL];

var configFilePath = path.join(__dirname, '..', 'config.json');
var config = configLoader.loadConfig(configFilePath);

// If you don't pass this flag the script will read in test mode
var force = (process.argv[2] === '-f' ? true : false);

var log = this.log = new bunyan({
    name: 'fix-now-owner',
    level: config.logLevel || 'debug',
    serializers: restify.bunyan.serializers
});
config.wfapi.log = log;

var morayClientConfig = jsprim.deepCopy(config.moray);
morayClientConfig.log = log.child({component: 'moray-client'}, true);

var morayClient = moray.createClient(morayClientConfig);

morayClient.on('connect', function onMorayClientConnected() {
    var morayStorage = new mod_morayStorage({
        morayClient: morayClient
    });

    morayStorage.setupBuckets(morayBucketsConfig,
        function onMorayBucketsSetup(morayBucketsSetupErr) {
            if (morayBucketsSetupErr) {
                log.error({error: morayBucketsSetupErr},
                    'Error when setting up moray buckets');
                morayClient.close();
                process.exitCode = 1;
            } else {
                fixVMsWithoutOwner();
            }
        });
});

function fixVMsWithoutOwner() {
    var wfapi = new WFAPI(config.wfapi);

    wfapi.connect(onWfapi);

    function onWfapi() {
        var params = { query: '(&(state=destroyed)!(owner_uuid=*))' };
        moray.listVms(params, function (err, vms) {
            async.mapSeries(vms, fixVM, function (ferr) {
                if (ferr) {
                    log.error({ err: ferr }, 'Could not fix all VMs');
                } else {
                    if (!force) {
                        log.info('Dry run results:');
                    }
                    log.info('%s corrupt VMs have been fixed', vms.length);
                }
            });
        });
    }

    function fixVM(vm, next) {
        var params = { vm_uuid: vm.uuid, task: 'destroy' };
        // Each VM should only have one destroy job
        // Just be careful and re-check the job is a destroy task
        wfapi.listJobs(params, function (err, jobs) {
            if (err) {
                return next(err);
            }

            if (!jobs.length) {
                log.info('VM %s does not have any jobs, skipping', vm.uuid);
                return next();
            }

            var job = jobs[0];
            if (job.params.task !== 'destroy' ||
                job.params.vm_uuid !== vm.uuid) {
                return next(
                    new Error('Expecting destroy job for VM ' + vm.uuid));
            } else if (job.params.owner_uuid === undefined) {
                return next(
                    new Error('Expecting owner_uuid for VM ' + vm.uuid));
            }

            vm.owner_uuid = job.params.owner_uuid;
            var m = common.translateVm(vm, false);
            if (!force) {
                log.debug({ vm: m }, 'Going to fix VM %s', vm.uuid);
                return next();
            }

            moray.putVm(vm.uuid, m, function (merr) {
                if (merr) {
                    return next(merr);
                }
                log.info('VM %s has been fixed', vm.uuid);
                return next();
            });
        });
    }
}
