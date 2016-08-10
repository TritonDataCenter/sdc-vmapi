/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

// Backfill image_uuid for KVM VMs

var assert = require('assert-plus');
var async = require('async');
var bunyan = require('bunyan');
var changefeed = require('changefeed');
var fs = require('fs');
var jsprim = require('jsprim');
var path = require('path');
var restify = require('restify');
var util = require('util');
var vasync = require('vasync');

var common = require('../lib/common');
var configLoader = require('../lib/config-loader');
var morayInit = require('../lib/moray/moray-init');
var WFAPI = require('../lib/apis/wfapi');

var changefeedPublisher;
var configFilePath = path.join(__dirname, '..', 'config.json');
var config = configLoader.loadConfig(configFilePath);

// If you don't pass this flag the script will read in test mode
var force = (process.argv[2] === '-f' ? true : false);

var log = this.log = new bunyan({
    name: 'fix-no-owner',
    level: config.logLevel || 'debug',
    serializers: restify.bunyan.serializers
});
config.wfapi.log = log;

var morayClient;
var moray;
var wfapi;

vasync.pipeline({funcs: [
    function initChangefeed(ctx, next) {
        var changefeedOptions;

        changefeedOptions = jsprim.deepCopy(config.changefeed);
        changefeedOptions.log = log.child({ component: 'changefeed' },
            true);

        changefeedPublisher = changefeed.createPublisher(changefeedOptions);
        changefeedPublisher.on('moray-ready', next);
    },
    function initMoray(ctx, next) {
        var morayBucketsInitializer;
        var moraySetup = morayInit.startMorayInit({
            morayConfig: config.moray,
            changefeedPublisher: changefeedPublisher,
            maxBucketsReindexAttempts: 1,
            maxBucketsSetupAttempts: 1
        });

        morayBucketsInitializer = moraySetup.morayBucketsInitializer;

        morayClient = moraySetup.morayClient;
        moray = moraySetup.moray;

        morayBucketsInitializer.on('error',
            function onMorayBucketsInitError(morayBucketsInitErr) {
                morayClient.close();
                next(morayBucketsInitErr);
            });

        morayBucketsInitializer.on('done', next);
    },
    function initWfApi(ctx, next) {
        wfapi = new WFAPI(config.wfapi);
        wfapi.connect();
        next();
    }
]}, function onInitDone(initErr) {
    var listVmsParams = { query: '(&(state=destroyed)!(owner_uuid=*))' };
    moray.listVms(listVmsParams, function onListVms(err, vms) {
        if (err) {
            log.error({err: err}, 'Error when listing VMs');
            changefeedPublisher.stop();
            moray.close();
        } else {
            log.info('All VMs listed successfully, processing them...');

            async.mapSeries(vms, fixVM, function (ferr) {
                if (ferr) {
                    log.error({ err: ferr }, 'Could not fix all VMs');
                } else {
                    if (!force) {
                        log.info('Dry run results:');
                    }
                    log.info('%s corrupt VMs have been fixed', vms.length);
                }

                changefeedPublisher.stop();
                morayClient.close();
                wfapi.client.close();
            });
        }
    });

    function fixVM(vm, next) {
        var listJobsParams = { vm_uuid: vm.uuid, task: 'destroy' };
        // Each VM should only have one destroy job
        // Just be careful and re-check the job is a destroy task
        wfapi.listJobs(listJobsParams, function (err, jobs) {
            var fixedVm = jsprim.deepCopy(vm);

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

            fixedVm.owner_uuid = job.params.owner_uuid;
            fixedVm = common.translateVm(fixedVm, false);
            if (!force) {
                log.debug({ vm: fixedVm }, 'Going to fix VM %s', vm.uuid);
                return next();
            }

            moray.putVm(vm.uuid, fixedVm, vm, function (merr) {
                if (merr) {
                    return next(merr);
                }
                log.info('VM %s has been fixed', vm.uuid);
                return next();
            });
        });
    }
});
