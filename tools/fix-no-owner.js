/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

// Backfill image_uuid for KVM VMs

var async = require('async');
var bunyan = require('bunyan');
var fs = require('fs');
var path = require('path');
var restify = require('restify');
var util = require('util');

var common = require('../lib/common');
var MORAY = require('../lib/apis/moray');
var WFAPI = require('../lib/apis/wfapi');

var config;

// If you don't pass this flag the script will read in test mode
var force = (process.argv[2] === '-f' ? true : false);

/*
 * Loads and parse the configuration file at config.json
 */
function loadConfig() {
    var CONFIG_FILE_PATH = path.join(__dirname, '..', 'config.json');

    if (!fs.existsSync(CONFIG_FILE_PATH)) {
        console.error('Config file not found: ' + CONFIG_FILE_PATH +
          ' does not exist. Aborting.');
        process.exit(1);
    }

    var theConfig = JSON.parse(fs.readFileSync(CONFIG_FILE_PATH, 'utf-8'));
    return theConfig;
}

config = loadConfig();

var log = this.log = new bunyan({
    name: 'fix-no-owner',
    level: config.logLevel || 'debug',
    serializers: restify.bunyan.serializers
});
config.wfapi.log = log;

var moray = new MORAY(config.moray);
var wfapi = new WFAPI(config.wfapi);

moray.connect();
moray.once('moray-ready', function () {
    var listVmsParams = { query: '(&(state=destroyed)!(owner_uuid=*))' };

    log.info('Connected to moray, listing all VMs');

    wfapi.connect();

    moray.listVms(listVmsParams, function onListVms(err, vms) {
        if (err) {
            log.error({err: err}, 'Error when listing VMs');
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

                moray.close();
            });
        }
    });

    function fixVM(vm, next) {
        var listJobsParams = { vm_uuid: vm.uuid, task: 'destroy' };
        // Each VM should only have one destroy job
        // Just be careful and re-check the job is a destroy task
        wfapi.listJobs(listJobsParams, function (err, jobs) {
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
});
