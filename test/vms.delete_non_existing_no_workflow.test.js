/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

// The goal of this test is to make sure that, when sending a DELETE request for
// a VM that has no server_uuid, a destroy workflow is not started and instead
// the request results in an error right away.

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
            var expectedErrMsg = 'Cannot delete a VM with no server_uuid';

            t.ok(err, 'deleting a vm with a null server_uuid should error');
            if (err) {
                t.equal(err.message, expectedErrMsg,
                    'Error message should be: ' + expectedErrMsg);
            }

            client.get('/vms/' + TEST_VM_UUID,
                function onGetVm(getVmErr, getVmReq, getVmRes, getVmBody) {
                    var expectedState = 'running';

                    t.ifError(getVmErr, 'Getting VM with uuid ' + TEST_VM_UUID +
                        ' should not error');
                    t.equal(getVmBody.state, expectedState,
                        'VM state should be ' + expectedState);

                    t.done();
                });
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
