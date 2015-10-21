/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

// This test tests the 'manual_override' state. It makes sure that all
// transitions from/to state === 'destroyed' that are valid per the
// documentation do not result in an error, and that all transitions that are
// invalid result in an error.

var assert = require('assert-plus');
var vasync = require('vasync');
var clone = require('clone');

var common = require('../lib/common');
var testCommon = require('./common');
var workflow = require('./lib/workflow');
var vmTest = require('./lib/vm');
var configFileLoader = require('../lib/config-loader');
var MORAY = require('../lib/apis/moray');

var testVm = require('../test/lib/vm');

var client;

var VMS_LIST_ENDPOINT = '/vms';

var vmLocation;
var vmObject;

var CONFIG = configFileLoader.loadConfig();

CONFIG.moray.reconnect = true;
CONFIG.moray.retry = {retries: Infinity, minTimeout: 500, maxTimeout: 2000};
var morayClient = new MORAY(CONFIG.moray);

exports.setUp = function (callback) {
    testCommon.setUp(function (err, _client) {
        assert.ifError(err);
        assert.ok(_client, 'restify client');
        client = _client;
        callback();
    });
};

exports.cleanup_leftover_test_vms = function (t) {
    morayClient.connect();
    morayClient.once('moray-ready', function () {
        testVm.deleteTestVMs(morayClient, {}, function allVmsDeleted(err) {
            morayClient.connection.close();
            t.done();
        });
    });
};

exports.create_state_destroyed_test_vm = function (t) {
    morayClient.connect();
    morayClient.once('moray-ready', function () {
        testVm.createTestVMs(1, morayClient, {}, {state: 'destroyed'},
            function allVmsCreated(err, testVmsUuid) {
                morayClient.connection.close();
                t.ifError(err);
                t.ok(Array.isArray(testVmsUuid) && testVmsUuid.length === 1);
                vmLocation = VMS_LIST_ENDPOINT + '/' + testVmsUuid[0];
                t.done();
            });
    });
};

exports.check_destroyed_vm_state = function (t) {
    // Use sync=true here to make sure that the VM's properties
    // are updated before we test their values.
    client.get(vmLocation + '?sync=true', function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        vmObject = body;

        t.equal(vmObject.state, 'destroyed', 'state should be "destroyed"');
        t.equal(vmObject.zone_state, 'destroyed',
            'zone_state should be "destroyed"');

        t.done();
    });
};

exports.any_state_to_and_from_manual_override_ok = function (t) {
    vasync.forEachPipeline({
        func: function testTransition(vmState, cb) {
            vasync.pipeline({
                funcs: [
                    function setManualOverrideState(args, next) {
                        var vmInNewState = clone(vmObject);
                        vmInNewState.state = 'manual_override';
                        client.put(vmLocation, vmInNewState,
                            function (err, req, res, body) {
                                t.equal(res.statusCode, 200,
                                    'setting state manual_override must ' +
                                    'always succeed');
                                t.equal(body.state, 'manual_override',
                                    'VM state must then be ' +
                                    '\'manual_override\'');

                                return next(err);
                            });
                    },
                    function setState(args, next) {
                        var vmInNewState = clone(vmObject);
                        vmInNewState.state = vmState;
                        client.put(vmLocation, vmInNewState,
                            function (err, req, res, body) {
                                t.equal(res.statusCode, 200,
                                    'Setting a VM to state \'' + vmState +
                                    '\' from state === \'manual_override\' ' +
                                    'must succeed');
                                t.equal(body.state, vmState, 'VM state must ' +
                                    'then be \'' + vmState + '\'');

                                return next(err);
                            });
                    }
                ]
            }, function testTransitionDone(err, results) {
                return cb(err);
            });
        },
        inputs: common.VALID_VM_STATES
    }, function testDone(err, results) {
        t.ifError(err);
        t.done();
    });
};
