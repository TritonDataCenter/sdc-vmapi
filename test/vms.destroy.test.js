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
                    // First make sure that the indestructible_zoneroot
                    // property is false so that we can actually destroy
                    // this VM.
                    client.post(testVmLocation + '?action=update&sync=true',
                        {indestructible_zoneroot: false},
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

/*
 * Now create a new "indestructible" VM that will be our guinea pig
 * for the rest of this tests suite.
 */

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
        indestructible_zoneroot: true,
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
        console.log('job location:', jobLocation);
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

exports.update_vmapi_cache_and_check_installed_state = function (t) {
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

exports.list_active_do_not_include_vms_being_destroyed = function (t) {
    client.get(VMS_LIST_ENDPOINT + '?state=active',
        function (err, req, res, body) {
            t.ifError(err);
            t.equal(res.statusCode, 200);
            t.ok(Array.isArray(body), 'response should be an array');
            t.equal(body.some(function (vm) {
                return vm.uuid === vmUuid;
            }),
            false,
            'The VM being destroyed should not be present in the list ' +
                'of active VMs');
            t.done();
        });
};

exports.get_destroying_vms_lists_one_vm = function (t) {
    client.get(VMS_LIST_ENDPOINT + '?transitive_state=destroying',
        function (err, req, res, body) {
            t.ifError(err);
            t.equal(res.statusCode, 200);
            t.ok(Array.isArray(body), 'response should be an array');
            t.equal(body.length, 1,
                'Only one VM should be in state === \'destroying\'');
            t.ok(body.length === 1 && body[0].uuid === vmUuid,
                'The only VM being destroyed must have the same UUID as the ' +
                'one we just tried to destroy');
            t.done();
        });
};

exports.post_on_destroying_vm_must_fail = function (t) {
    var UPDATE_VM_ACTIONS = [
        'start',
        'stop',
        'kill',
        'reboot',
        'update',
        'reprovision',
        'add_nics',
        'update_nics',
        'remove_nics',
        'create_snapshot',
        'rollback_snapshot',
        'delete_snapshot'
    ];

    vasync.forEachParallel({
        inputs: UPDATE_VM_ACTIONS,
        func: function (updateVmAction, next) {
            client.post(vmLocation + '?action=' + updateVmAction, {foo: 'bar'},
                function (err, req, res, body) {
                    t.equal(res.statusCode, 409);
                    var expectedError = {
                        code: 'VMBeingDestroyed',
                        message:
                            'Invalid operation while this VM is being destroyed'
                    };
                    t.deepEqual(body, expectedError);
                    return next();
                });
        }
    }, function allDone(err) {
        t.ifError(err);
        t.done();
    });
};

exports.remove_indestructible_flag = function (t) {
    client.post(vmLocation + '?action=update&sync=true',
        {indestructible_zoneroot: false}, function (err, req, res, body) {
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

        t.ok(vmObject.indestructible_zoneroot === false ||
            vmObject.indestructible_zoneroot === undefined,
            'indestructible_zoneroot flag should now be set to false');
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
            'transitive_state must not be set');

        t.done();
    });
};

exports.get_destroying_vms_before_updating_cache_lists_no_vm = function (t) {
    client.get(VMS_LIST_ENDPOINT + '?transitive_state=destroying',
        function (err, req, res, body) {
            t.ifError(err);
            t.equal(res.statusCode, 200);
            t.ok(Array.isArray(body), 'response should be an array');
            t.equal(body.length, 0,
                'No VM should be in state === \'destroying\'');
            t.done();
        });
};

exports.get_destroying_vms_after_updating_cache_lists_no_vm = function (t) {
    client.get(VMS_LIST_ENDPOINT + '?transitive_state=destroying',
        function (err, req, res, body) {
            t.ifError(err);
            t.equal(res.statusCode, 200);
            t.ok(Array.isArray(body), 'response should be an array');
            t.equal(body.length, 0,
                'No VM should be in state === \'destroying\'');
            t.done();
        });
};

exports.put_on_destroyed_vm_with_non_destroyed_state_must_fail = function (t) {
    vasync.forEachParallel({
        inputs: common.VALID_VM_STATES,
        func: function (vmState, next) {
            // Do not set the state to 'manual_override', as it would change
            // the VM state to 'manual_override' and we want the VM to be in
            // state 'destoyed' for the duration of this test.
            if (vmState === 'manual_override') {
                return next();
            }

            var vmInNewState = clone(vmObject);
            vmInNewState.state = vmState;
            client.put(vmLocation, vmInNewState,
                function (err, req, res, body) {
                    // Setting the state of a VM that is being destroyed
                    // to any state, including to another state that is *not*
                    // 'destroyed' is a valid operation, but the state of the
                    // VM is actually _not_ changed.
                    t.equal(res.statusCode, 200);
                    t.equal(body.state, 'destroyed');

                    return next(err);
                });
        }
    }, function allDone(err) {
        t.ifError(err);
        t.done();
    });
};

exports.post_on_destroyed_vm_must_fail = function (t) {
    var UPDATE_VM_ACTIONS = [
        'start',
        'stop',
        'kill',
        'reboot',
        'update',
        'reprovision',
        'add_nics',
        'update_nics',
        'remove_nics',
        'create_snapshot',
        'rollback_snapshot',
        'delete_snapshot'
    ];

    vasync.forEachParallel({
        inputs: UPDATE_VM_ACTIONS,
        func: function (updateVmAction, next) {
            client.post(vmLocation + '?action=' + updateVmAction, {foo: 'bar'},
                function (err, req, res, body) {
                    t.equal(res.statusCode, 409);
                    var expectedError = {
                        code: 'ChangingDestroyedVM',
                        message: 'Invalid operation on a destroyed VM'
                    };
                    t.deepEqual(body, expectedError);
                    return next();
                });
        }
    }, function allDone(err) {
        t.ifError(err);
        t.done();
    });
};

exports.remove_indestructible_flag_on_destroyed_vm_should_fail = function (t) {
    client.post(vmLocation + '?action=update&sync=true',
        {indestructible_zoneroot: false}, function (err, req, res, body) {
        t.ok(err);
        t.equal(res.statusCode, 409);
        var expectedError = {
            code: 'ChangingDestroyedVM',
            message: 'Invalid operation on a destroyed VM'
        };
        t.deepEqual(body, expectedError);
        t.done();
    });
};
