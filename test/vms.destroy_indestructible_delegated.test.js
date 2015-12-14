/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var assert = require('assert-plus');
var vasync = require('vasync');
var clone = require('clone');
var ldapjs = require('ldapjs');

var common = require('../lib/common');
var testCommon = require('./common');
var workflow = require('./lib/workflow');
var vmTest = require('./lib/vm');

var client;
var MORAY = require('../lib/apis/moray');

var IMAGE = 'fd2cc906-8938-11e3-beab-4359c665ac99';
var CUSTOMER = testCommon.config.ufdsAdminUuid;
var NETWORKS = null;
var SERVER = null;

var VMS_LIST_ENDPOINT = '/vms';

var vmLocation;
var jobLocation;
var vmUuid;
var vmObject;
var leftoverTestVms = [];
var leftoverTestVmsDestroyJobUuids = [];

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

exports.napi_networks_ok = function (t) {
    client.napi.get('/networks?provisionable_by=' + CUSTOMER,
        function (err, req, res, networks) {
            t.ifError(err);
            t.equal(res.statusCode, 200);
            t.ok(networks);
            t.ok(Array.isArray(networks));
            t.ok(networks.length > 1);
            NETWORKS = networks;
            t.done();
        });
};

/*
 * Fist, delete any leftover VMs from a previous tests run that may not have
 * been cleaned up properly.
 */
exports.get_leftover_test_vms = function (t) {
    vasync.pipeline({
        funcs: [
            function getDestroyingLeftoverVms(args, callback) {
                client.get(VMS_LIST_ENDPOINT + '?alias=' +
                    vmTest.TEST_VMS_ALIAS + '&transitive_state=destroying',
                    function (err, req, res, body) {
                        t.equal(res.statusCode, 200);
                        t.ok(Array.isArray(body));

                        leftoverTestVms = leftoverTestVms.concat(body);
                        return callback(err);
                    });
            },
            function getActiveLeftoverVms(args, callback) {
                client.get(VMS_LIST_ENDPOINT + '?alias=' +
                    vmTest.TEST_VMS_ALIAS + '&state=active',
                    function (err, req, res, body) {
                        t.equal(res.statusCode, 200);
                        t.ok(Array.isArray(body));

                        leftoverTestVms = leftoverTestVms.concat(body);
                        return callback(err);
                    });
            }
        ]
    }, function allDone(err) {
        t.ifError(err);
        t.done();
    });
};

exports.remove_leftover_test_vms = function (t) {
    function removeLeftoverVm(testVm, callback) {
        var testVmLocation = '/vms/' + testVm.uuid;
        vasync.pipeline({
            funcs: [
                function updateIndestructibleFlag(arg, next) {
                    // First make sure that the indestructible_delegated
                    // property is false so that we can actually destroy
                    // this VM.
                    client.post(testVmLocation + '?action=update&sync=true',
                        {indestructible_delegated: false},
                        function (err, req, res, body) {
                            t.equal(res.statusCode, 202);
                            return next(err);
                        });
                },
                function removeVm(arg, next) {
                    // Then actually delete it
                    client.del(testVmLocation,
                        function (err, req, res, body) {
                            t.ifError(err);
                            t.equal(res.statusCode, 202);
                            testCommon.checkHeaders(t, res.headers);
                            t.ok(body);
                            leftoverTestVmsDestroyJobUuids.push(body.job_uuid);

                            return next();
                        });
                }
            ]
        }, function done(err) {
            return callback(err);
        });
    }

    vasync.forEachPipeline({
        inputs: leftoverTestVms,
        func: removeLeftoverVm
    }, function allVmsDestroyed(err) {
        t.ifError(err);
        t.done();
    });
};

exports.wait_for_leftover_vms_to_actually_be_destroyed = function (t) {
    vasync.forEachParallel({
        inputs: leftoverTestVmsDestroyJobUuids,
        func: function (jobUuid, next) {
            var destroyJobLocation = '/jobs/' + jobUuid;
            workflow.waitForValue(client, destroyJobLocation, 'execution',
                'succeeded', next);
        }
    }, function allDestroyJobsDone(err) {
        t.ifError(err);
        t.done();
    });
};

exports.create_indestructible_vm = function (t) {
    var md = {
        foo: 'bar',
        credentials: JSON.stringify({ 'user_pw': '12345678' })
    };

    var opts = {path: VMS_LIST_ENDPOINT};

    var INDESTRUCTIBLE_VM_PAYLOAD = {
        owner_uuid: CUSTOMER,
        image_uuid: IMAGE,
        server_uuid: SERVER.uuid,
        networks: [ { uuid: NETWORKS[0].uuid } ],
        brand: 'joyent-minimal',
        billing_id: '00000000-0000-0000-0000-000000000000',
        ram: 64,
        quota: 10,
        customer_metadata: md,
        creator_uuid: CUSTOMER,
        delegate_dataset: true,
        indestructible_delegated: true,
        alias: vmTest.TEST_VMS_ALIAS
    };

    client.post(opts, INDESTRUCTIBLE_VM_PAYLOAD,
        function (err, req, res, body) {
            t.ifError(err);
            t.equal(res.statusCode, 202);
            testCommon.checkHeaders(t, res.headers);
            t.ok(res.headers['workflow-api'], 'workflow-api header');
            t.ok(body, 'vm ok');

            jobLocation = '/jobs/' + body.job_uuid;
            vmUuid = body.vm_uuid;
            vmLocation = '/vms/' + vmUuid;
            t.done();
        });
};

exports.get_job = function (t) {
    client.get(jobLocation, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200, 'GetJob 200 OK');
        testCommon.checkHeaders(t, res.headers);
        t.ok(body, 'job ok');
        workflow.checkJob(t, body);
        t.done();
    });
};

exports.wait_provisioned_job = function (t) {
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
            t.ifError(err);
            t.done();
        });
};

exports.try_destroy_indestructible_vm = function (t) {
    client.del(vmLocation, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        testCommon.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};

exports.wait_destroy_vm_failure = function (t) {
    workflow.waitForValue(client, jobLocation, 'execution', 'failed',
        function (err) {
            t.ifError(err);
            t.done();
        });
};

exports.update_vmapi_cache_and_check_state = function (t) {
    client.get(vmLocation + '?sync=true', function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        vmObject = body;

        t.equal(vmObject.state, 'stopped', 'state should be "stopped"');
        t.equal(vmObject.zone_state, 'installed',
            'zone_state should be "installed"');
        t.equal(vmObject.transitive_state, 'destroying',
            'transitive_state should be "destroying"');
        t.done();
    });
};

exports.remove_indestructible_flag = function (t) {
    client.post(vmLocation + '?action=update&sync=true',
        {indestructible_delegated: false}, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        t.done();
    });
};

exports.check_indestructible_flag_is_removed = function (t) {
    // Use sync=true here to make sure that the VM's properties
    // are updated before we test their values.
    client.get(vmLocation + '?sync=true', function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        vmObject = body;

        t.ok(vmObject.indestructible_delegated === false ||
            vmObject.indestructible_delegated === undefined,
            'indestructible_delegated flag should now not be set');
        t.done();
    });
};

exports.destroy_destructible_vm = function (t) {
    var opts = {path: vmLocation};

    client.del(opts, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        testCommon.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};

exports.wait_destroy_vm_succeeded = function (t) {
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
            t.ifError(err);
            t.done();
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
        t.equal(vmObject.transitive_state, undefined,
            'transitive_state should not be set');
        t.done();
    });
};
