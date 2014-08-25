/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

// Backfill image_uuid for KVM VMs
var path = require('path');
var fs = require('fs');
var util = require('util');
var MORAY = require('../lib/apis/moray');

var config_file = path.resolve(__dirname, '..', 'config.json');
var bunyan = require('bunyan');
var levels = [bunyan.TRACE, bunyan.DEBUG, bunyan.INFO,
              bunyan.WARN, bunyan.ERROR, bunyan.FATAL];
var config;
var log;
var VMS_LIMIT = (process.env.VMS_LIMIT) ? Number(process.env.VMS_LIMIT) : 10;

// Total number of VMs
var TOTAL = 0;
// Number of VMs we've finished with:
var PROCESSED = 0;

fs.readFile(config_file, 'utf8', function (err, data) {
    if (err) {
        console.error('Error reading config file:');
        console.dir(err);
        process.exit(1);
    } else {
        try {
            config = JSON.parse(data);
        } catch (e) {
            console.error('Error parsing config file JSON:');
            console.dir(e);
            process.exit(1);
        }
    }

    log = new bunyan({
        name: 'kvm-backfill',
        streams: [ {
            level: config.logLevel || 'info',
            stream: process.stdout
        }]
    });

    var moray = new MORAY(config.moray);
    moray.connect();
    moray.once('moray-ready', onMoray);

    function onMoray() {
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

            moray.countVms({ brand: 'kvm' }, onCount);

            function onCount(cerr, count) {
                if (cerr) {
                    log.error({err: err}, 'Could not get count of vms');
                    process.exit(1);
                }

                var query = { brand: 'kvm', offset: offset, limit: limit };
                moray.listVms(query, true, function (err, vms) {
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

                            moray.putVm(vm.uuid, vm, function (perr) {
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
                if (err.message ===
                        'the underlying connection has been closed') {
                    log.warn('Waiting for moray to reconnect');
                    moray.once('moray-connected', function () {
                        processVms(PROCESSED, VMS_LIMIT, processCb);
                    });
                }
                return (false);
            } else if (PROCESSED < TOTAL) {
                log.info('% %d', PROCESSED, TOTAL);
                return processVms(PROCESSED, VMS_LIMIT, processCb);
            } else {
                log.info('%d VMS PROCESSED. DONE!', TOTAL);
                return (true);
            }
        }
    }
});
