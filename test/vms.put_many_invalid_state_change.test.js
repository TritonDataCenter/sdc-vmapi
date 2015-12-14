/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

// The first part of this test creates a large number of VMs with
// state === 'destroyed', and then attempts to change their state to 'running'
// with a PUT /vms request.
// Changing the state of a VM from state === 'destroyed' to any state that is
// !== 'destroyed' is an invalid transition. However, it should not result in a
// request failure, instead the state change should be overriden and all VMs
// should still be 'destroyed' after the PUT /vms request.
//
// The second part of this test also test invalid transitions for the
// zone_state property. It creates test VMs with zone_state === 'destroyed'
// and attempts to change their zone_state property with PUT /vms to a
// non-destroyed state. It is also an invalid transition, but instead of being
// silently overriden, it is considered as an error. Thus, the test makes
// sure that this request results in an error.

var path = require('path');
var fs = require('fs');

var bunyan = require('bunyan');
var restify = require('restify');
var assert = require('assert-plus');
var vasync = require('vasync');

var testVm = require('../test/lib/vm');
var testCommon = require('./common');
var configFileLoader = require('../lib/config-loader');

var MORAY = require('../lib/apis/moray');
var VMS_LIST_ENDPOINT = '/vms';
// Use a large number of VMs so that the test requires to fetch several "pages"
// of data from VMAPI, and even when interacting with moray. The current
// default limit for VMAPI and moray's server being 1000 entries per page,
// so 1001 test VMs forces this test to do paginated reads from both of these
// components.
var NB_TEST_VMS = 1001;

var CONFIG = configFileLoader.loadConfig();

CONFIG.moray.reconnect = true;
CONFIG.moray.retry = {retries: Infinity, minTimeout: 500, maxTimeout: 2000};
var MORAY_CLIENT = new MORAY(CONFIG.moray);

var client;
var SERVER;

function createTestVms(nbTestVms, morayClient, params, cb) {
    assert.number(nbTestVms, 'nbTestVms must be a number');
    assert.object(morayClient, 'morayClient must be an object');
    assert.object(params, 'params must be an object');
    assert.func(cb, 'cb must be a function');

    morayClient.connect();
    morayClient.once('moray-ready', function () {
        testVm.createTestVMs(NB_TEST_VMS, morayClient, {},
            params, function allVmsCreated(err) {
                morayClient.connection.close();
                return cb(err);
            });
    });
}

function removeTestVms(morayClient, cb) {
    assert.object(morayClient, 'morayClient must be an object');
    assert.func(cb, 'cb must be a function');

    morayClient.connect();
    morayClient.once('moray-ready', function () {
        testVm.deleteTestVMs(morayClient, {}, function allVmsDeleted(err) {
            morayClient.connection.close();
            return cb(err);
        });
    });
}

exports.setUp = function (callback) {
    testCommon.setUp(function (err, _client) {
        assert.ifError(err);
        assert.ok(_client, 'restify client');
        client = _client;
        callback();
    });
};

exports.find_headnode = function (t) {
    client.cnapi.get('/servers?headnode=true',
        function (err, req, res, servers) {
            t.ifError(err);
            t.equal(res.statusCode, 200);
            t.ok(servers);
            t.ok(Array.isArray(servers));
            for (var i = 0; i < servers.length; i++) {
                if (servers[i].headnode === true) {
                    SERVER = servers[i];
                    break;
                }
            }
            t.ok(SERVER);
            t.done();
        });
};

exports.cleanup_leftover_test_vms = function (t) {
    removeTestVms(MORAY_CLIENT, function vmsRemoved(err) {
        t.done();
        return;
    });
};

exports.create_state_destroyed_test_vms = function (t) {
    createTestVms(NB_TEST_VMS, MORAY_CLIENT, {
        state: 'destroyed',
        zone_state: 'installed',
        server_uuid: SERVER.uuid
    }, function testVmsCreated() {
        t.done();
    });
};

exports.change_destroyed_test_vms_state = function (t) {
    vasync.waterfall([
        function getVms(next) {
            client.sdcClient.listVms({alias: testVm.TEST_VMS_ALIAS},
                function (err, vms) {
                    var allVmsDestroyed = false;

                    t.ifError(err, 'the response should not be an error');
                    t.ok(Array.isArray(vms),
                        'the response body should be an array');
                    t.equal(vms.length, NB_TEST_VMS, 'there should be ' +
                        NB_TEST_VMS + ' objects in the response');

                    allVmsDestroyed = vms.every(function checkVmState(vm) {
                        return vm.state === 'destroyed';
                    });

                    t.equal(allVmsDestroyed, true,
                        'All test VMs should have their state set to ' +
                        '\'destroyed\'');

                    next(err, vms);
                    return;
                });
        },
        function changeAllVmsState(vms, next) {
            var vmsPayload = {};
            vms.forEach(function changeVmState(vm) {
                var vmWithStateChanged = vm;
                vmWithStateChanged.state = 'running';
                vmsPayload[vm.uuid] = vmWithStateChanged;
            });

            client.put('/vms?server_uuid=' + SERVER.uuid, {vms: vmsPayload},
                function (err, req, res, body) {
                    t.equal(res.statusCode, 200,
                        'changing VMs state should succeed');
                    return next(err);
                });
        },
        function checkVmsState(next) {
            client.sdcClient.listVms({alias: testVm.TEST_VMS_ALIAS},
                function (err, vms) {
                    var allVmsDestroyed = false;

                    t.ok(Array.isArray(vms),
                        'the response body should be an array');
                    t.equal(vms.length, NB_TEST_VMS, 'there should be ' +
                        NB_TEST_VMS + ' objects in the response');

                    allVmsDestroyed = vms.every(function checkVmState(vm) {
                        return vm.state === 'destroyed';
                    });

                    t.equal(allVmsDestroyed, true,
                        'All test VMs should have their state set to ' +
                        '\'destroyed\'');

                    next(err);
                    return;
                });
        }
    ], function changeTestVmsDone(err, results) {
        t.ifError(err);
        t.done();
        return;
    });
};

exports.cleanup_state_destroyed_test_vms = function (t) {
    removeTestVms(MORAY_CLIENT, function vmsRemoved(err) {
        t.done();
        return;
    });
};

exports.create_zone_state_destroyed_test_vms = function (t) {
    createTestVms(NB_TEST_VMS, MORAY_CLIENT, {
        state: 'destroyed',
        zone_state: 'destroyed',
        server_uuid: SERVER.uuid
    }, function testVmsCreated() {
        t.done();
    });
};

exports.change_destroyed_test_vms_zone_state = function (t) {
    vasync.waterfall([
        function getVms(next) {
            client.sdcClient.listVms({alias: testVm.TEST_VMS_ALIAS},
                function (err, vms) {
                    var allVmsDestroyed = false;

                    t.ifError(err);
                    t.ok(Array.isArray(vms));
                    t.equal(vms.length, NB_TEST_VMS);

                    allVmsDestroyed = vms.every(function checkVmState(vm) {
                        return vm.zone_state === 'destroyed' &&
                            vm.zone_state === 'destroyed';
                    });

                    t.equal(allVmsDestroyed, true,
                        'All test VMs should have their state and zone_state '+
                            'set to \'destroyed\'');

                    next(err, vms);
                    return;
                });
        },
        function changeAllVmsZoneState(vms, next) {
            var vmsPayload = {};
            vms.forEach(function changeVmState(vm) {
                var vmWithZoneStateChanged = vm;
                vmWithZoneStateChanged.zone_state = 'installed';
                vmsPayload[vm.uuid] = vmWithZoneStateChanged;
            });

            client.put('/vms?server_uuid=' + SERVER.uuid, {vms: vmsPayload},
                function (err, req, res, body) {
                    t.ok(err);
                    t.equal(res.statusCode, 409,
                        'changing VMs zone_state should fail');
                    return next();
                });
        },
        function checkVmsState(next) {
            client.sdcClient.listVms({alias: testVm.TEST_VMS_ALIAS},
                function (err, vms) {
                    var allVmsDestroyed = false;

                    t.ok(Array.isArray(vms));
                    t.equal(vms.length, NB_TEST_VMS);

                    allVmsDestroyed = vms.every(function checkVmState(vm) {
                        return vm.state === 'destroyed' &&
                            vm.zone_state === 'destroyed';
                    });
                    t.equal(allVmsDestroyed, true,
                        'All test VMs should have their state and ' +
                        'zone_state set to \'destroyed\'');

                    next(err);
                    return;
                });
        }
    ], function changeTestVmsDone(err, results) {
        t.ifError(err);
        t.done();
        return;
    });
};

exports.cleanup_zone_state_destroyed_test_vms = function (t) {
    removeTestVms(MORAY_CLIENT, function vmsRemoved(err) {
        t.done();
        return;
    });
};
