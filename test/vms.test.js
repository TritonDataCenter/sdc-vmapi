// Copyright 2011 Joyent, Inc.  All rights reserved.

// var test = require('tap').test;
var assert = require('assert');
var uuid = require('node-uuid');

var common = require('./common');


// --- Globals

var client;
var muuid;
var newUuid;
var jobLocation;
var vmLocation;

var DATASET = '01b2c898-945f-11e1-a523-af1afbe22822';
var CUSTOMER = '00000000-0000-0000-0000-000000000000';
var NETWORKS = null;

// In seconds
var TIMEOUT = 90;


// --- Helpers

function checkMachine(t, vm) {
    t.ok(vm.uuid, 'uuid');
    t.ok(vm.brand, 'brand');
    t.ok(vm.ram, 'ram');
    t.ok(vm.max_swap, 'swap');
    t.ok(vm.quota, 'disk');
    t.ok(vm.cpu_shares, 'cpu shares');
    t.ok(vm.max_lwps, 'lwps');
    t.ok(vm.create_timestamp, 'create timestamp');
    t.ok(vm.state, 'state');
    t.ok(vm.zfs_io_priority, 'zfs io');
    t.ok(vm.owner_uuid, 'owner uuid');
}


function checkJob(t, job) {
    t.ok(job.uuid, 'uuid');
    t.ok(job.name, 'name');
    t.ok(job.execution, 'execution');
    t.ok(job.params, 'params');
}


function checkEqual(value, expected) {
    if ((typeof (value) === 'object') && (typeof (expected) === 'object')) {
        var exkeys = Object.keys(expected);
        for (var i = 0; i < exkeys.length; i++) {
            var key = exkeys[i];
            if (value[key] !== expected[key])
                return false;
        }

        return true;
    } else {
        return (value === expected);
    }
}


function checkValue(url, key, value, callback) {
    return client.get(url, function (err, req, res, body) {
        if (err) {
            return callback(err);
        }

        return callback(null, checkEqual(body[key], value));
    });
}


var times = 0;

function waitForValue(url, key, value, callback) {

    function onReady(err, ready) {
        if (err) {
            callback(err);
            return;
        }

        if (!ready) {
            times++;

            if (times == TIMEOUT) {
                throw new Error('Timeout waiting on ' + url);
            } else {
                setTimeout(function () {
                    waitForValue(url, key, value, callback);
                }, 1000);
            }
        } else {
            times = 0;
            callback(null);
        }
    }

    return checkValue(url, key, value, onReady);
}



// --- Tests

exports.setUp = function (callback) {
    common.setUp(function (err, _client) {
        assert.ifError(err);
        assert.ok(_client, 'restify client');
        client = _client;
        callback();
    });
};


exports.napi_networks_ok = function (t) {
    client.napi.get('/networks', function (err, req, res, networks) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.ok(networks);
        t.ok(Array.isArray(networks));
        NETWORKS = [ { uuid: networks[0].uuid } ];
        t.done();
    });
};


exports.filter_vms_empty = function (t) {
    var path = '/vms?ram=32&owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        t.ok(Array.isArray(body));
        t.ok(!body.length);
        t.done();
    });
};


exports.filter_vms_ok = function (t) {
    var path = '/vms?ram=' + 128 + '&owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['x-joyent-resource-count']);
        t.ok(body);
        t.ok(Array.isArray(body));
        t.ok(body.length);
        body.forEach(function (m) {
            checkMachine(t, m);
            muuid = m.uuid;
        });
        t.done();
    });
};


exports.head_vms_ok = function (t) {
    var path = '/vms?ram=' + 128 + '&owner_uuid=' + CUSTOMER;
    client.head(path, function (err, req, res) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['x-joyent-resource-count']);
        t.done();
    });
};


exports.get_vm_not_found = function (t) {
    var nouuid = uuid();
    var path = '/vms/' + nouuid + '?owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, body) {
        t.equal(res.statusCode, 404);
        common.checkHeaders(t, res.headers);
        t.done();
    });
};


exports.get_vm_ok = function (t) {
    var path = '/vms/' + muuid + '?owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'vm ok');
        checkMachine(t, body);
        t.done();
    });
};


exports.head_vm_ok = function (t) {
    var path = '/vms/' + muuid + '?owner_uuid=' + CUSTOMER;
    client.head(path, function (err, req, res) {
        t.ifError(err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.done();
    });
};


exports.create_vm_not_ok = function (t) {
    client.post('/vms', { owner_uuid: CUSTOMER },
      function (err, req, res, data) {
        t.equal(res.statusCode, 409);
        common.checkHeaders(t, res.headers);
        t.done();
    });
};


exports.create_vm = function (t) {
    var vm = {
        owner_uuid: CUSTOMER,
        dataset_uuid: DATASET,
        networks: NETWORKS,
        brand: 'joyent-minimal',
        billing_id: '00000000-0000-0000-0000-000000000000',
        package_name: 'smartos',
        package_version: '1.6.5',
        ram: 64
    };

    client.post('/vms', vm,
      function (err, req, res, body) {
          t.ifError(err);
          t.equal(res.statusCode, 202);
          common.checkHeaders(t, res.headers);
          t.ok(body, 'vm ok');
          jobLocation = '/jobs/' + body.job_uuid;
          newUuid = body.vm_uuid;
          vmLocation = '/vms/' + newUuid;
          t.done();
    });
};


exports.get_job = function (t) {
    client.get(jobLocation, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200, 'GetJob 200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'job ok');
        checkJob(t, body);
        t.done();
    });
};


exports.wait_provisioned_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.stop_vm = function (t) {
    client.post(vmLocation, { action: 'stop' },
      function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_stopped_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.start_vm = function (t) {
    client.post(vmLocation, { action: 'start' },
      function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_started_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.reboot_vm = function (t) {
    client.post(vmLocation, { action: 'reboot' },
      function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_rebooted_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


// Adding this test due to JPC-1045 bug, where a change to owner_uuid was
// requested with an empty owner_uuid value:
exports.change_owner_without_uuid = function (t) {
    client.post(vmLocation, { action: 'update', owner_uuid: '' },
      function (err, req, res, body) {
          t.equal(res.statusCode, 409);
          t.done();
    });
};



exports.list_tags = function (t) {
    var path = '/vms/' + newUuid + '/tags?owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body');
        t.ok(!Object.keys(body).length, 'empty body');
        t.done();
    });
};


exports.add_tags = function (t) {
    var path = '/vms/' + newUuid + '/tags?owner_uuid=' + CUSTOMER;
    var query = {
        role: 'database',
        group: 'deployment'
    };

    client.post(path, query, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_new_tag_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.wait_new_tag = function (t) {
    var tags = {
        role: 'database',
        group: 'deployment'
    };

    waitForValue(vmLocation, 'tags', tags, function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.get_tag = function (t) {
    var path = '/vms/' + newUuid + '/tags/role?owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, data) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        common.checkHeaders(t, res.headers);
        t.ok(data);
        t.equal(data, 'database');
        t.done();
    });
};


exports.delete_tag = function (t) {
    var path = '/vms/' + newUuid + '/tags/role?owner_uuid=' + CUSTOMER;

    client.del(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_delete_tag_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.wait_delete_tag = function (t) {
    var tags = {
        group: 'deployment'
    };

    waitForValue(vmLocation, 'tags', tags, function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.delete_tags = function (t) {
    var path = '/vms/' + newUuid + '/tags?owner_uuid=' + CUSTOMER;

    client.del(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_delete_tags_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.wait_delete_tags = function (t) {
    waitForValue(vmLocation, 'tags', {}, function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.set_tags = function (t) {
    var path = '/vms/' + newUuid + '/tags?owner_uuid=' + CUSTOMER;
    var query = {
        role: 'database',
        group: 'deployment'
    };

    client.put(path, query, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_set_tags_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.wait_set_tags = function (t) {
    var tags = {
        role: 'database',
        group: 'deployment'
    };

    waitForValue(vmLocation, 'tags', tags, function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.snapshot_vm = function (t) {
    client.post(vmLocation + '/snapshot', { name: 'backup' },
      function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_snapshot_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.rollback_vm = function (t) {
    client.post(vmLocation + '/rollback', { name: 'backup' },
      function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_rollback_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.destroy_vm = function (t) {
    client.del(vmLocation, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_destroyed_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.filter_jobs_ok = function (t) {
    var path = '/jobs?task=provision&vm_uuid=' + newUuid;

    client.get(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        t.ok(Array.isArray(body));
        t.equal(body.length, 1);
        t.done();
    });
};


exports.filter_vm_jobs_ok = function (t) {
    var path = '/vms/' + newUuid + '/jobs?task=reboot';

    client.get(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        t.ok(Array.isArray(body));
        t.equal(body.length, 1);
        t.done();
    });
};

exports.create_nonautoboot_vm = function (t) {
    var vm = {
        owner_uuid: CUSTOMER,
        dataset_uuid: DATASET,
        networks: NETWORKS,
        brand: 'joyent-minimal',
        billing_id: '00000000-0000-0000-0000-000000000000',
        package_name: 'smartos',
        package_version: '1.6.5',
        ram: 64,
		autoboot: false
    };

    client.post('/vms', vm,
      function (err, req, res, body) {
          t.ifError(err);
          t.equal(res.statusCode, 202);
          common.checkHeaders(t, res.headers);
          t.ok(body, 'vm ok');
          jobLocation = '/jobs/' + body.job_uuid;
          newUuid = body.vm_uuid;
          vmLocation = '/vms/' + newUuid;
          t.done();
    });
};


exports.get_nonautoboot_job = function (t) {
    client.get(jobLocation, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200, 'GetJob 200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'job ok');
        checkJob(t, body);
        t.done();
    });
};


exports.wait_nonautoboot_provisioned_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.change_autoboot = function (t) {
    client.post(vmLocation, { action: 'update', autoboot: true },
      function (err, req, res, body) {
		t.ifError(err);
        t.equal(res.statusCode, 202);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_autoboot_update_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.get_nonautoboot_vm_ok = function (t) {
    var path = '/vms/' + newUuid + '?owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'vm ok');
        checkMachine(t, body);
		t.equal(body.state, 'stopped');
        t.done();
    });
};


exports.destroy_nonautoboot_vm = function (t) {
    client.del(vmLocation, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_nonautoboot_destroyed_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};
