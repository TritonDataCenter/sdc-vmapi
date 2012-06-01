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
var machineLocation;

var DATASET = '01b2c898-945f-11e1-a523-af1afbe22822';
var CUSTOMER = '930896af-bf8c-48d4-885c-6573a94b1853';
var NETWORKS = '54b51c03-41c7-4cbf-980b-8faee4270a4d';


// --- Helpers

function checkMachine(t, machine) {
    t.ok(machine.uuid, 'uuid');
    t.ok(machine.brand, 'brand');
    t.ok(machine.ram, 'ram');
    t.ok(machine.max_swap, 'swap');
    t.ok(machine.quota, 'disk');
    t.ok(machine.cpu_shares, 'cpu shares');
    t.ok(machine.max_lwps, 'lwps');
    t.ok(machine.create_timestamp, 'create timestamp');
    t.ok(machine.state, 'state');
    t.ok(machine.zfs_io_priority, 'zfs io');
    t.ok(machine.owner_uuid, 'owner uuid');
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
    return client.get(url, function (err, req, res, data) {
        if (err)
            return callback(err);

        var body = JSON.parse(data);
        return callback(null, checkEqual(body[key], value));
    });
}


function waitForValue(url, key, value, callback) {
    return checkValue(url, key, value, function (err, ready) {
        if (err)
            return callback(err);

        if (!ready)
            return setTimeout(function () {
                waitForValue(url, key, value, callback);
            }, 3000);

        return setTimeout(function () {
            callback(null);
        }, 20000);
    });
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


exports.filter_machines_empty = function(t) {
    var path = '/machines?ram=32&owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, data) {
        var body = JSON.parse(data);
        t.ifError(err);
        t.equal(res.statusCode, 200);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        t.ok(Array.isArray(body));
        t.ok(!body.length);
        t.done();
    });
};


exports.filter_machines_ok = function(t) {
    var path = '/machines?ram=' + 64 + '&owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, data) {
        var body = JSON.parse(data);
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


exports.get_machine_not_found = function(t) {
    var nouuid = uuid();
    var path = '/machines/' + nouuid + '?owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, body) {
        t.equal(res.statusCode, 404);
        common.checkHeaders(t, res.headers);
        t.done();
    });
};


exports.get_machine_ok = function(t) {
    var path = '/machines/' + muuid + '?owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, data) {
        var body = JSON.parse(data);
        t.ifError(err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'machine ok');
        checkMachine(t, body);
        t.done();
    });
};


exports.create_machine_not_ok = function(t) {
    client.post('/machines', { owner_uuid: CUSTOMER },
      function (err, req, res, data) {
        t.equal(res.statusCode, 409);
        common.checkHeaders(t, res.headers);
        t.done();
    });
};


exports.create_machine = function(t) {
    var machine = {
        owner_uuid: CUSTOMER,
        dataset_uuid: DATASET,
        networks: NETWORKS,
        brand: 'joyent',
        ram: 64
    };

    client.post('/machines', machine,
      function (err, req, res, data) {
          var body = JSON.parse(data);
          t.ifError(err);
          t.equal(res.statusCode, 201, '201 Created');
          common.checkHeaders(t, res.headers);
          t.ok(body, 'machine ok');
          t.ok(res.headers['job-location'], 'job location');

          jobLocation = res.headers['job-location'];
          newUuid = body.uuid;
          t.done();
    });
};


exports.get_job = function (t) {
    client.get(jobLocation, function (err, req, res, data) {
        var body = JSON.parse(data);
        t.ifError(err);
        t.equal(res.statusCode, 200, 'GetJob 200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'job ok');
        checkJob(t, body);
        t.done();
    });
};


exports.wait_provisioned = function(t) {
    machineLocation = '/machines/' + newUuid;
    waitForValue(machineLocation, 'state', 'running', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.stop_machine = function(t) {
    client.post(machineLocation, { action: 'stop' },
      function (err, req, res, data) {
          t.ifError(err);
          t.equal(res.statusCode, 200, 'Stop 200 OK');
          common.checkHeaders(t, res.headers);
          t.ok(res.headers['job-location'], 'job location');

          jobLocation = res.headers['job-location'];
          t.done();
    });
};


exports.wait_stopped = function(t) {
    waitForValue(machineLocation, 'state', 'stopped', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.start_machine = function(t) {
    client.post(machineLocation, { action: 'start' },
      function (err, req, res, data) {
          t.ifError(err);
          t.equal(res.statusCode, 200, 'Start 200 OK');
          common.checkHeaders(t, res.headers);
          t.ok(res.headers['job-location'], 'job location');

          jobLocation = res.headers['job-location'];
          t.done();
    });
};


exports.wait_started = function(t) {
    waitForValue(machineLocation, 'state', 'running', function (err) {
       t.ifError(err);
        t.done();
    });
};


exports.reboot_machine = function(t) {
    client.post(machineLocation, { action: 'reboot' },
      function (err, req, res, data) {
          t.ifError(err);
          t.equal(res.statusCode, 200, 'Reboot 200 OK');
          common.checkHeaders(t, res.headers);
          t.ok(res.headers['job-location'], 'job location');

          jobLocation = res.headers['job-location'];
          t.done();
    });
};


exports.wait_rebooted = function(t) {
    setTimeout(function (){
        waitForValue(machineLocation, 'state', 'running', function (err) {
            t.ifError(err);
            t.done();
        });
    }, 10000);
};


exports.list_tags = function(t) {
    var path = '/machines/' + newUuid + '/tags?owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, data) {
        var body = JSON.parse(data);
        t.ifError(err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body');
        t.ok(!Object.keys(body).length, 'empty body');
        t.done();
    });
};


exports.add_tags = function(t) {
    var path = '/machines/' + newUuid + '/tags?owner_uuid=' + CUSTOMER;
    var query = 'role=database&group=deployment';

    client.post(path, query, function (err, req, res, data) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['job-location'], 'job location');
        t.done();
    });
};


exports.wait_new_tag = function(t) {
    var tags = {
        role: 'database',
        group: 'deployment'
    };

    waitForValue(machineLocation, 'tags', tags, function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.get_tag = function(t) {
    var path = '/machines/' + newUuid + '/tags/role?owner_uuid=' + CUSTOMER;

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
    var path = '/machines/' + newUuid + '/tags/role?owner_uuid=' + CUSTOMER;

    client.del(path, function (err, req, res) {
        t.ifError(err);
        t.equal(res.statusCode, 204);
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['job-location'], 'job location');
        t.done();
    });
};


exports.wait_delete_tag = function(t) {
    var tags = {
        group: 'deployment'
    };

    waitForValue(machineLocation, 'tags', tags, function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.delete_tags = function(t) {
    var path = '/machines/' + newUuid + '/tags?owner_uuid=' + CUSTOMER;

    client.del(path, function (err, req, res) {
        t.ifError(err);
        t.equal(res.statusCode, 204);
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['job-location'], 'job location');
        t.done();
    });
};


exports.wait_delete_tags = function(t) {
    waitForValue(machineLocation, 'tags', {}, function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.destroy_machine = function(t) {
    client.del(machineLocation, function (err, req, res, data) {
          t.ifError(err);
          t.equal(res.statusCode, 200, 'Destroy 200 OK');
          common.checkHeaders(t, res.headers);
          t.ok(res.headers['job-location'], 'job location');

          jobLocation = res.headers['job-location'];
          t.done();
    });
};


exports.wait_destroyed = function(t) {
    waitForValue(machineLocation, 'state', 'destroyed', function (err) {
        t.ifError(err);
        t.done();
    });
};
