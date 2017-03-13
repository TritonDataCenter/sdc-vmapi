/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

// The goal of this test is to make sure that, when sending a DELETE request
// for a VM that has no server_uuid, or for which the server_uuid does not
// represent a CN that actually exists, a destroy workflow is not started and
// instead the VM's state is set to destroyed immediately.

var assert = require('assert-plus');
var libuuid = require('libuuid');

var common = require('./common');
var moray = require('../lib/apis/moray');
var morayTest = require('./lib/moray');
var vmTest = require('./lib/vm');

var client;
var TEST_VM_UUID = libuuid.create();
var NON_EXISTING_CN_UUID = libuuid.create();

exports.setUp = function (callback) {
    common.setUp(function (err, _client) {
        assert.ifError(err);
        assert.ok(_client, 'restify client');
        client = _client;
        callback();
    });
};

exports.create_vm_with_null_server_uuid = function (t) {
    client.put('/vms/' + TEST_VM_UUID, {
        uuid: TEST_VM_UUID,
        alias: vmTest.TEST_VMS_ALIAS,
        state: 'running'
    }, function onPutDone(err, req, res, newVm) {
        t.ifError(err, 'The test VM should be created succesfully');
        t.ok(newVm, 'The response should contain a VM object');
        t.equal(newVm.server_uuid, null,
            'The server_uuid property of the test VM should be null');
        t.done();
    });
};

exports.delete_vm_with_null_server_uuid = function (t) {
    client.del('/vms/' + TEST_VM_UUID,
        function onVmDeleted(err, req, res, body) {
            t.ifError(err);
            t.equal(body.state, 'destroyed',
                'The response body should have a state set to destroyed');
            t.equal(body.job_uuid, undefined,
                'The response body should not have a job uuid');
            t.done();
        });
};

exports.create_vm_on_non_existing_server_uuid = function (t) {
    client.put('/vms/' + TEST_VM_UUID, {
        uuid: TEST_VM_UUID,
        server_uuid: NON_EXISTING_CN_UUID,
        alias: vmTest.TEST_VMS_ALIAS,
        state: 'running'
    }, function onPutDone(err, req, res, newVm) {
        t.ifError(err, 'The test VM should be created succesfully');
        t.ok(newVm, 'The response should contain a VM object');
        t.equal(newVm.server_uuid, NON_EXISTING_CN_UUID,
            'The server_uuid property of the test VM should be the uuid of ' +
            'the non-existing CN');
        t.done();
    });
};

exports.delete_vm_on_non_existing_server_uuid = function (t) {
    client.del('/vms/' + TEST_VM_UUID,
        function onVmDeleted(err, req, res, body) {
            t.ifError(err);
            t.equal(body.state, 'destroyed',
                'The response body should have a state set to destroyed');
            t.equal(body.job_uuid, undefined,
                'The response body should not have a job uuid');
            t.done();
        });
};

exports.create_provisioning_vm = function (t) {
    client.put('/vms/' + TEST_VM_UUID, {
        uuid: TEST_VM_UUID,
        alias: vmTest.TEST_VMS_ALIAS,
        state: 'provisioning'
    }, function onPutDone(err, req, res, newVm) {
        t.ifError(err, 'The test VM should be created succesfully');
        t.ok(newVm, 'The response should contain a VM object');
        t.equal(newVm.server_uuid, null,
            'The server_uuid property of the test VM should be null');
        t.equal(newVm.state, 'provisioning',
            'The new VM should be in the provisioning state');
        t.done();
    });
};

exports.delete_provisioning_vm = function (t) {
    client.del('/vms/' + TEST_VM_UUID,
        function onVmDeleted(err, req, res, body) {
            t.ok(err);
            t.equal(res.statusCode, 409,
                'The server should respond with a 409 HTTP status code');
            t.done();
        });
};

exports.cleanup_test_vms = function (t) {
    var morayClient = morayTest.createMorayClient();
    morayClient.connect();

    morayClient.once('moray-ready', function () {
        vmTest.deleteTestVMs(morayClient, {}, function testVmDeleted(err) {
            morayClient.connection.close();
            t.ifError(err, 'Deleting the test VM should not error');
            t.done();
        });
    });
};
