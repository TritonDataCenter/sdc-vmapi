/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var assert = require('assert-plus');
var async = require('async');
var clone = require('clone');

var common = require('./common');
var workflow = require('./lib/workflow');
var vmTest = require('./lib/vm');

var client;
var MORAY = require('../lib/apis/moray');

var IMAGE = 'fd2cc906-8938-11e3-beab-4359c665ac99';
var CUSTOMER = common.config.ufdsAdminUuid;
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
    common.setUp(function (err, _client) {
        assert.ifError(err);
        assert.ok(_client, 'restify client');
        client = _client;
        callback();
    });
};

exports.find_headnode = function (t) {
    client.cnapi.get('/servers', function (err, req, res, servers) {
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
    client.napi.get('/networks', function (err, req, res, networks) {
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
 * Fist, delete any leftover VMs from a previous tests run that may have failed
 * and left VMs in the transitive_state = 'destroying' without actually
 * destroying them.
 */

exports.get_leftover_destroying_test_vms = function (t) {
    client.get(VMS_LIST_ENDPOINT + '?alias=' + vmTest.TEST_VMS_ALIAS +
        '&transitive_state=destroying',
        function (err, req, res, body) {
            t.ifError(err);
            t.equal(res.statusCode, 200);
            t.ok(Array.isArray(body));
            leftoverTestVms = leftoverTestVms.concat(body);
            t.done();
        });
};

/*
 * Also delete active VMs whose alias is the test vms alias.
 */
exports.get_leftover_active_test_vms = function (t) {
    client.get(VMS_LIST_ENDPOINT + '?alias=' + vmTest.TEST_VMS_ALIAS +
        '&state=active',
        function (err, req, res, body) {
            t.ifError(err);
            t.equal(res.statusCode, 200);
            t.ok(Array.isArray(body));
            leftoverTestVms = leftoverTestVms.concat(body);
            t.done();
        });
};

exports.remove_leftover_test_vms = function (t) {
    async.each(leftoverTestVms, function (testVm, nextVm) {
        var testVmLocation = '/vms/' + testVm.uuid;
        async.series([
            function updateIndestructibleFlag(next) {
                // First make sure that the indestructible_zoneroot property is
                // false so that we can actually destroy this VM.
                client.post(testVmLocation + '?action=update',
                    {indestructible_zoneroot: false},
                    function (err, req, res, body) {
                        t.equal(res.statusCode, 202);
                        return next(err);
                    });
            },
            function removeVm(next) {
                // Then actually delete it
                client.del(testVmLocation, function (err, req, res, body) {
                    t.ifError(err);
                    t.equal(res.statusCode, 202);
                    common.checkHeaders(t, res.headers);
                    t.ok(body);
                    leftoverTestVmsDestroyJobUuids.push(body.job_uuid);

                    return next();
                });
            }
        ], function allDone(err) {
            return nextVm(err);
        });
    }, function allVmsDestroyed(err) {
        t.ifError(err);
        t.done();
    });
};

exports.wait_for_leftover_vms_to_actually_be_destroyed = function (t) {
    async.each(leftoverTestVmsDestroyJobUuids, function (jobUuid, next) {
        var destroyJobLocation = '/jobs/' + jobUuid;
        workflow.waitForValue(client, destroyJobLocation, 'execution',
            'succeeded', function (err) {
                t.ifError(err);
                return next();
            });
    }, function allDestroyJobsDone(err) {
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
        origin: 'cloudapi',
        role_tags: ['fd48177c-d7c3-11e3-9330-28cfe91a33c9'],
        indestructible_zoneroot: true,
        alias: 'test--',
        // needed so that the VM is marked as destroyed without
        // waiting for it to actually be destroyed.
        docker: true,
        internal_metadata: {
            'docker:cmd': '["/bin/bash"]'
        }
    };

    client.post(opts, INDESTRUCTIBLE_VM_PAYLOAD,
        function (err, req, res, body) {
            t.ifError(err);
            t.equal(res.statusCode, 202);
            common.checkHeaders(t, res.headers);
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
        common.checkHeaders(t, res.headers);
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
        common.checkHeaders(t, res.headers);
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

        t.equal(vmObject.transitive_state, 'destroying',
            'transitive_state should be "destroying"');
        t.equal(vmObject.state, 'destroyed', 'state should be "destroyed"');
        t.equal(vmObject.zone_state, 'installed',
            'zone_state should be "installed"');
        t.done();
    });
};

exports.list_active_do_not_include_vms_being_destroyed = function (t) {
    client.get(VMS_LIST_ENDPOINT + '?state=active',
        function (err, req, res, body) {
            t.ifError(err);
            t.equal(res.statusCode, 200);
            t.ok(Array.isArray(body), 'response should be an array');
            t.equal(false, body.some(function (vm) {
                return vm.uuid === vmUuid;
            }), 'The VM being destroyed should not be present in the list ' +
                'of active VMs');
            t.done();
        });
};

exports.list_transitive_state_destroying_lists_one_vm = function (t) {
    client.get(VMS_LIST_ENDPOINT + '?transitive_state=destroying',
        function (err, req, res, body) {
            t.ifError(err);
            t.equal(res.statusCode, 200);
            t.ok(Array.isArray(body), 'response should be an array');
            t.ok(body.length === 1 && body[0].uuid === vmUuid,
                'only one VM should be in transitive_state===\'destroying\'' +
                'and it must have the same  UUID as the one we just tried to ' +
                'destroy');
            t.done();
        });
};

exports.put_on_destroying_vm_with_non_destroyed_state_must_fail = function (t) {
    var VALID_VM_STATES = [
        'running',
        'stopped',
        'active',
        'destroyed'
    ];

    async.each(VALID_VM_STATES, function (vmState, next) {
        if (vmState === 'destroyed') {
            // Skip setting state to 'destroyed', as
            // this would be a valid operation and we actually
            // need this VM to not be in the 'destroyed' state just
            // now for the next tests in this tests suite.
            return next();
        }

        var vmInNewState = clone(vmObject);
        vmInNewState.state = vmState;
        client.put(vmLocation, vmInNewState, function (err, req, res, body) {
            if (vmInNewState.state !== vmObject.state) {
                // Setting the state of a VM that is being destroyed
                // to another state that is *not* 'destroyed' should result
                // in an error.
                t.equal(res.statusCode, 409);
                var expectedError = {
                    code: 'VMBeingDestroyed',
                    message:
                        'Invalid operation while this VM is being destroyed'
                };
                t.deepEqual(body, expectedError);
            } else {
                // However, setting the state of a VM that is being destroyed
                // to the *same* state is valid.
                t.ifError(err);
                t.equal(res.statusCode, 200);
            }

            return next();
        });
    }, function allDone(err) {
        t.ifError(err);
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

    async.each(UPDATE_VM_ACTIONS, function (updateVmAction, next) {
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
    }, function allDone(err) {
        t.ifError(err);
        t.done();
    });
};

exports.update_vmapi_cache_and_check_state = function (t) {
    client.get(vmLocation + '?sync=true', function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        vmObject = body;

        t.equal(vmObject.transitive_state, 'destroying',
            'transitive_state should be "destroying"');
        t.equal(vmObject.state, 'destroyed', 'state should be "destroyed"');
        t.equal(vmObject.zone_state, 'installed',
            'zone_state should be "installed"');
        t.done();
    });
};

exports.remove_indestructible_flag = function (t) {
    client.post(vmLocation + '?action=update',
        {indestructible_zoneroot: false}, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        t.done();
    });
};

exports.destroy_destructible_vm = function (t) {
    var opts = {path: vmLocation};

    client.del(opts, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
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
    client.get(vmLocation, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        vmObject = body;

        t.equal(vmObject.transitive_state, 'destroying',
            'transitive_state should be "destroying"');
        t.equal(vmObject.state, 'destroyed', 'state should be "destroyed"');
        t.equal(vmObject.zone_state, 'destroyed',
            'zone_state should be "destroyed"');

        t.done();
    });
};
