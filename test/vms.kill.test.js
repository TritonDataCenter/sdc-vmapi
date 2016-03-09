/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
var libuuid = require('libuuid');

var client;
var jobLocation;
var vmLocation;

var common = require('./common');
var testVm = require('./lib/vm');
var workflow = require('./lib/workflow');

var TEST_SMARTOS_IMAGE_UUID = 'fd2cc906-8938-11e3-beab-4359c665ac99';
var TEST_CUSTOMER_UUID = common.config.ufdsAdminUuid;
var NETWORKS = null;
var SERVER = null;
var DOCKER_BUSYBOX_IMAGE;

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

exports.create_vm = function (t) {
    var vm = {
        alias: testVm.getUniqueTestVMName('kill-test'),
        owner_uuid: TEST_CUSTOMER_UUID,
        image_uuid: TEST_SMARTOS_IMAGE_UUID,
        server_uuid: SERVER.uuid,
        networks: [ { uuid: NETWORKS[0].uuid } ],
        brand: 'joyent-minimal',
        billing_id: '00000000-0000-0000-0000-000000000000',
        ram: 64,
        quota: 10,
        creator_uuid: TEST_CUSTOMER_UUID,
        // Set restart_init to false so that init doesn't restart when the VM
        // is killed with SIGKILL and we can check that the signal was
        // properly sent and handled by checking that the VM is stopped.
        restart_init: false
    };

    var opts = {
        path: '/vms'
    };

    client.post(opts, vm, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['workflow-api'], 'workflow-api header');
        t.ok(body, 'vm ok');

        jobLocation = '/jobs/' + body.job_uuid;
        vmLocation = '/vms/' + body.vm_uuid;

        client.get(vmLocation, function (err2, req2, res2, body2) {
            t.ifError(err2);
            t.equal(res2.statusCode, 200, '200 OK');
            common.checkHeaders(t, res2.headers);
            t.ok(body2, 'provisioning vm ok');

            client.post(vmLocation, { action: 'stop' },
              function (err3, req3, res3, body3) {
                t.equal(res3.statusCode, 409, 'cannot stop unprovisioned VM');
                common.checkHeaders(t, res3.headers);
                t.done();
            });
        });
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

exports.kill_vm_with_default_signal_ok = function (t) {
    var params = {
        action: 'kill',
        sync: 'true'
    };

    var opts = {
        path: vmLocation
    };

    client.post(opts, params, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        t.done();
    });
};


// The previous request didn't specify a signal, and thus the default signal
// was sent by vmadm to the VM, which is SIGTERM. SIGTERM doesn't terminate
// the init process of a container, and thus the VM should still be running.
exports.check_vm_is_still_running = function (t) {
    client.get({path: vmLocation}, function (err, req, res, body) {
        t.equal(body.state, 'running');
        t.done();
    });
};

exports.kill_vm_with_symbolic_kill_signal_ok = function (t) {
    var params = {
        action: 'kill',
        signal: 'SIGKILL',
        sync: 'true'
    };

    var opts = {
        path: vmLocation
    };

    client.post(opts, params, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        t.done();
    });
};

// The previous request specified a SIGKILL signal, which terminates the init
// process of a SmartOS container, and thus the VM should be stopped.
exports.check_vm_is_stopped_after_symbolic_sigkill = function (t) {
    client.get({path: vmLocation}, function (err, req, res, body) {
        t.equal(body.state, 'stopped');
        t.done();
    });
};

exports.restart_stopped_vm_after_symbolic_sigkill = function (t) {
    var params = {
        action: 'start',
        sync: 'true'
    };

    var opts = {
        path: vmLocation
    };

    client.post(opts, params, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        t.done();
    });
};

exports.check_vm_is_running_after_restart_from_symbolic_sigkill =
    function (t) {
        client.get({path: vmLocation}, function (err, req, res, body) {
            t.equal(body.state, 'running');
            t.done();
        });
    };

exports.kill_vm_with_numeric_signal_as_string_ok = function (t) {
    var params = {
        action: 'kill',
        signal: '9',
        sync: 'true'
    };

    var opts = {
        path: vmLocation
    };

    client.post(opts, params, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        t.done();
    });
};

// The previous request specified a SIGKILL signal with its numeric
// representaiton ('9'), which terminates the init process of a SmartOS
// container, and thus the VM should be stopped.
exports.check_vm_is_stopped_after_numeric_sigkill = function (t) {
    client.get({path: vmLocation}, function (err, req, res, body) {
        t.equal(body.state, 'stopped');
        t.done();
    });
};

exports.restart_stopped_vm_after_numeric_sigkill = function (t) {
    var params = {
        action: 'start',
        sync: 'true'
    };

    var opts = {
        path: vmLocation
    };

    client.post(opts, params, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        t.done();
    });
};

exports.check_vm_is_running_after_restart_from_numeric_sigkill = function (t) {
    client.get({path: vmLocation}, function (err, req, res, body) {
        t.equal(body.state, 'running');
        t.done();
    });
};

// The "signal" parameter of the KillVm endpoint has to be a string, not a
// number, so this test results in an invalid parameter error.
exports.kill_vm_with_numeric_signal_as_number_ko = function (t) {
    var params = {
        action: 'kill',
        signal: 9
    };

    var opts = {
        path: vmLocation + '?action=update'
    };

    client.post(opts, params, function (err, req, res, body) {
        t.ok(err);
        t.equal(res.statusCode, 409);
        t.done();
    });
};

exports.check_vm_is_still_running_after_failed_kill = function (t) {
    client.get({path: vmLocation}, function (err, req, res, body) {
        t.equal(body.state, 'running');
        t.done();
    });
};

exports.delete_vm = function (t) {
    var opts = {
        path: vmLocation + '?sync=true'
    };

    client.del(opts, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        t.done();
    });
};
