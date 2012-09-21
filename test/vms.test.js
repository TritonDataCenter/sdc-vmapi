// Copyright 2011 Joyent, Inc.  All rights reserved.

//var test = require('tap').test;
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
var CUSTOMER = '930896af-bf8c-48d4-885c-6573a94b1853';
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
    if ((typeof(value) === 'object') && (typeof(expected) === 'object')) {
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
            return callback(err);
        }

        if (!ready) {
            times++;

            if (times == TIMEOUT) {
                throw new Error('Timeout waiting on ' + url);
            } else {
                return setTimeout(function () {
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

exports.setUp = function(callback) {
    common.setUp(function (err, _client) {
        assert.ifError(err);
        assert.ok(_client, 'restify client');
        client = _client;
        callback();
    });
};


exports.napi_networks_ok = function(t) {
    client.napi.get('/networks', function (err, req, res, networks) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.ok(networks);
        t.ok(Array.isArray(networks));
        NETWORKS = [{ uuid: networks[0].uuid }];
        t.done();
    });
};


exports.filter_vms_empty = function(t) {
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


exports.filter_vms_ok = function(t) {
    var path = '/vms?ram=' + 64 + '&owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        common.checkHeaders(t, res.headers);
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


exports.get_vm_not_found = function(t) {
    var nouuid = uuid();
    var path = '/vms/' + nouuid + '?owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, body) {
        t.equal(res.statusCode, 404);
        common.checkHeaders(t, res.headers);
        t.done();
    });
};


exports.get_vm_ok = function(t) {
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


exports.create_vm_not_ok = function(t) {
    client.post('/vms', { owner_uuid: CUSTOMER },
      function (err, req, res, data) {
        t.equal(res.statusCode, 409);
        common.checkHeaders(t, res.headers);
        t.done();
    });
};


exports.create_vm = function(t) {
    var vm = {
        owner_uuid: CUSTOMER,
        dataset_uuid: DATASET,
        networks: NETWORKS,
        brand: 'joyent-minimal',
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


exports.wait_provisioned_job = function(t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.wait_provisioned = function(t) {
    vmLocation = '/vms/' + newUuid;
    waitForValue(vmLocation, 'state', 'running', function (err) {
        t.ifError(err);

        // Zoneinit mainly causing the zone to not be completely ready
        // to receive a stop/reboot
        return setTimeout(function () {
            t.done();
        }, 10000);
    });
};


exports.stop_vm = function(t) {
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


exports.wait_stopped_job = function(t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.wait_stopped = function(t) {
    waitForValue(vmLocation, 'state', 'stopped', function (err) {
        t.ifError(err);

        return setTimeout(function () {
            t.done();
        }, 10000);
    });
};


exports.start_vm = function(t) {
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


exports.wait_started_job = function(t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.wait_started = function(t) {
    waitForValue(vmLocation, 'state', 'running', function (err) {
       t.ifError(err);
        t.done();
    });
};


exports.reboot_vm = function(t) {
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


exports.wait_rebooted_job = function(t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.wait_rebooted = function(t) {
    waitForValue(vmLocation, 'state', 'running', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.list_tags = function(t) {
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


exports.add_tags = function(t) {
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


exports.wait_new_tag_job = function(t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.wait_new_tag = function(t) {
    var tags = {
        role: 'database',
        group: 'deployment'
    };

    waitForValue(vmLocation, 'tags', tags, function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.get_tag = function(t) {
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


exports.delete_tag = function(t) {
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


exports.wait_delete_tag_job = function(t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.wait_delete_tag = function(t) {
    var tags = {
        group: 'deployment'
    };

    waitForValue(vmLocation, 'tags', tags, function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.delete_tags = function(t) {
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


exports.wait_delete_tags_job = function(t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.wait_delete_tags = function(t) {
    waitForValue(vmLocation, 'tags', {}, function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.set_tags = function(t) {
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


exports.wait_set_tags_job = function(t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.wait_set_tags = function(t) {
    var tags = {
        role: 'database',
        group: 'deployment'
    };

    waitForValue(vmLocation, 'tags', tags, function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.destroy_vm = function(t) {
    client.del(vmLocation, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_destroyed_job = function(t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.wait_destroyed = function(t) {
    waitForValue(vmLocation, 'state', 'destroyed', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.filter_jobs_ok = function(t) {
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


exports.filter_vm_jobs_ok = function(t) {
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
