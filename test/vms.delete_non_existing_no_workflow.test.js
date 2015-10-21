/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

// The goal of this test is to make sure that, when sending a DELETE request
// for a VM that has no server_uuid, or for which the server_uuid does not
// represent a CN that actually exists, a destroy workflow is not started and
// instead the VM's state is set to destroyed immediately.

var libuuid = require('libuuid');
var assert = require('assert-plus');
var vasync = require('vasync');

var common = require('./common');
var vmTest = require('./lib/vm');
var moray = require('../lib/apis/moray');

var client;
var NON_EXISTING_CN_UUID = libuuid.create();

exports.setUp = function (callback) {
    common.setUp(function (err, _client) {
        assert.ifError(err);
        assert.ok(_client, 'restify client');
        client = _client;
        callback();
    });
};

exports.delete_vm_with_null_server_uuid = function (t) {
    vasync.pipeline({
        funcs: [
            function createTestVm(testVmUuid, next) {
                client.put('/vms/' + testVmUuid, {
                    uuid: testVmUuid,
                    alias: vmTest.TEST_VMS_ALIAS,
                    state: 'running'
                }, function onPutDone(err, req, res, newVm) {
                    t.ifError(err, 'The test VM should be created succesfully');
                    t.ok(newVm, 'The response should contain a VM object');
                    t.equal(newVm.server_uuid, null,
                        'The server_uuid property of the test VM should be ' +
                        'null');
                    return next(err);
                });
            },
            function deleteTestVm(testVmUuid, next) {
                client.del('/vms/' + testVmUuid,
                    function onVmDeleted(err, req, res, body) {
                        t.ifError(err);
                        t.equal(body.state, 'destroyed',
                            'The response body should have a state set to ' +
                            'destroyed');
                        t.equal(body.job_uuid, undefined,
                            'The response body should not have a job uuid');
                        return next(err);
                    });
            }
        ],
        arg: libuuid.create()
    }, function testDone(err) {
        t.ifError(err);
        t.done();
    });
};

exports.delete_vm_on_non_existing_server_uuid = function (t) {
    vasync.pipeline({
        funcs: [
            function createTestVm(testVmUuid, next) {
                client.put('/vms/' + testVmUuid, {
                    uuid: testVmUuid,
                    server_uuid: NON_EXISTING_CN_UUID,
                    alias: vmTest.TEST_VMS_ALIAS,
                    state: 'running'
                }, function onPutDone(err, req, res, newVm) {
                    t.ifError(err, 'The test VM should be created succesfully');
                    t.ok(newVm, 'The response should contain a VM object');
                    t.equal(newVm.server_uuid, NON_EXISTING_CN_UUID,
                        'The server_uuid property of the test VM should be ' +
                        'the uuid of the non-existing CN');
                    return next(err);
                });
            },
            function deleteTestVm(testVmUuid, next) {
                client.del('/vms/' + testVmUuid,
                    function onVmDeleted(err, req, res, body) {
                        t.ifError(err);
                        t.equal(body.state, 'destroyed',
                            'The response body should have a state set to ' +
                            'destroyed');
                        t.equal(body.job_uuid, undefined,
                            'The response body should not have a job uuid');
                        return next(err);
                    });
            }
        ],
        arg: libuuid.create()
    }, function testDone(err) {
        t.ifError(err);
        t.done();
    });
};

exports.delete_provisioning_vm = function (t) {
    vasync.pipeline({
        funcs: [
            function createTestVm(testVmUuid, next) {
                client.put('/vms/' + testVmUuid, {
                    uuid: testVmUuid,
                    alias: vmTest.TEST_VMS_ALIAS,
                    state: 'provisioning'
                }, function onPutDone(err, req, res, newVm) {
                    t.ifError(err,
                        'The test VM should be created succesfully');
                    t.ok(newVm, 'The response should contain a VM object');
                    t.equal(newVm.server_uuid, null,
                        'The server_uuid property of the test VM should be ' +
                        'null');
                    t.equal(newVm.state, 'provisioning',
                        'The new VM should be in the provisioning state');
                    return next(err);
                });
            },
            function deleteTestVm(testVmUuid, next) {
                client.del('/vms/' + testVmUuid,
                function onVmDeleted(err, req, res, body) {
                    t.ok(err);
                    t.equal(res.statusCode, 409,
                        'The server should respond with a 409 HTTP status ' +
                        'code');
                    // Swallow error on purpose, because having err != null is
                    // the expected behavior, so we don't pass the error to the
                    // next step.
                    return next();
                });
            }
        ],
        arg: libuuid.create()
    }, function testDone(err) {
        t.ifError(err);
        t.done();
    });
};

exports.cleanup_test_vms = function (t) {
    var morayClient = new moray(common.config.moray);
    morayClient.connect();

    morayClient.once('moray-ready', function () {
        vmTest.deleteTestVMs(morayClient, {}, function testVmDeleted(err) {
            morayClient.connection.close();
            t.ifError(err, 'Deleting the test VM should not error');
            t.done();
        });
    });
};
