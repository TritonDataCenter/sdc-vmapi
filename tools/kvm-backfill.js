/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

// Backfill image_uuid for KVM VMs
var bunyan = require('bunyan');
var fs = require('fs');
var jsprim = require('jsprim');
var moray = require('moray');
var path = require('path');
var util = require('util');

var configLoader = require('../lib/config-loader');
var mod_morayStorage = require('../lib/storage/moray/moray');
var morayBucketsConfig = require('../lib/storage/moray/moray-buckets-config');

var configFilePath = path.resolve(__dirname, '..', 'config.json');
var config = configLoader.loadConfig(configFilePath);

var levels = [bunyan.TRACE, bunyan.DEBUG, bunyan.INFO,
              bunyan.WARN, bunyan.ERROR, bunyan.FATAL];

var VMS_LIMIT = (process.env.VMS_LIMIT) ? Number(process.env.VMS_LIMIT) : 10;

// Total number of VMs
var TOTAL = 0;
// Number of VMs we've finished with:
var PROCESSED = 0;

var morayStorage;

var log = new bunyan({
    name: 'kvm-backfill',
    streams: [ {
        level: config.logLevel || 'info',
        stream: process.stdout
    }]
});

var morayClientConfig = jsprim.deepCopy(config.moray);
morayClientConfig.log = log.child({component: 'moray-client'}, true);

var morayClient = moray.createClient(morayClientConfig);

morayClient.on('connect', function onMorayClientConnected() {
    morayStorage = new mod_morayStorage({
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
                startProcessingVMs();
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

function startProcessingVMs() {
    processVms(0, VMS_LIMIT, processCb);

    function processVms(offset, limit, cb) {
        var done = 0;

        function wait() {
            log.info('inside wait %d %d', done, limit);

            if (done === limit) {
                return cb();
            } else {
                return setTimeout(wait, 1000);
            }
        }

        morayStorage.countVms({ brand: 'kvm' }, onCount);

        function onCount(countVmsErr, count) {
            if (countVmsErr) {
                log.error({err: countVmsErr}, 'Could not get count of vms');
                process.exit(1);
            }

            var query = { brand: 'kvm', offset: offset, limit: limit };
            morayStorage.listVms(query, true, function (err, vms) {
                if (err) {
                    log.error({err: err}, 'Error fetching VMs');
                    return processCb(err);
                }
                // Should happen just on first pass
                if (TOTAL === 0) {
                    TOTAL = count;
                }
                if (count < limit) {
                    limit = count;
                }

                vms.forEach(processVm);
                function processVm(vm) {
                    var disks = vm.disks;

                    // If VM has a value here then it's already good
                    if (vm.image_uuid) {
                        PROCESSED += 1;
                        done += 1;
                        log.info('VM %d of %d already processed',
                                    PROCESSED, TOTAL);
                        return;
                    }

                    try {
                        if (typeof (disks) == 'string') {
                            disks = JSON.parse(disks);
                        }
                    } catch (e) {
                        PROCESSED += 1;
                        done += 1;

                        log.error({
                            err: e,
                            vm_uuid: vm.uuid
                        }, 'Error parsing VM disks, skipping.');
                        return;
                    }

                    if (disks && disks[0] && disks[0].image_uuid) {
                        vm.image_uuid = disks[0].image_uuid;

                        morayStorage.putVm(vm.uuid, vm, function (perr) {
                            PROCESSED += 1;
                            done += 1;

                            if (perr) {
                                log.error({
                                    err: perr,
                                    vm_uuid: vm.uuid
                                }, 'Error updating VM');
                            } else {
                                log.info({
                                    vm_uuid: vm.uuid,
                                    server_uuid: vm.server_uuid
                                },
                                util.format('VM %d of %d updated',
                                    PROCESSED, TOTAL));
                            }
                        });

                    // This should never happen
                    } else {
                        PROCESSED += 1;
                        done += 1;
                        log.warn({ vm_uuid: vm.uuid }, 'Error does not ' +
                        'have standard disks array, skipping.');
                    }
                }

                return wait();
            });
        }
    }

    function processCb(err) {
        if (err) {
            console.log(err.message);
        }

        if (PROCESSED < TOTAL) {
            log.info('% %d', PROCESSED, TOTAL);
            return processVms(PROCESSED, VMS_LIMIT, processCb);
        } else {
            log.info('%d VMS PROCESSED. DONE!', TOTAL);
            morayClient.close();
            return (true);
        }
    }
}
