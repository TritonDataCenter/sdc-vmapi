// Copyright 2011 Joyent, Inc.  All rights reserved.

var test = require('tap').test;
var uuid = require('node-uuid');

var common = require('./common');
var createMachine = require('../tools/create_machine');


// --- Globals

var client;
var newMachine;
var muuid;
var ouuid;
var jobLocation;
var machineLocation;

var newUuid;

var DATASET = '01b2c898-945f-11e1-a523-af1afbe22822';
var NETWORKS = 'bdd13e81-ca24-4a8f-b664-d38ba65da5e0';

var TAP_CONF = {
    timeout: 'Infinity '
};


// --- Helpers

function checkMachine(t, machine) {
    t.ok(machine.uuid, 'uuid');
    t.ok(machine.alias, 'alias');
    t.ok(machine.brand, 'brand');
    t.ok(machine.ram, 'ram');
    t.ok(machine.max_swap, 'swap');
    t.ok(machine.quota, 'disk');
    t.ok(machine.cpu_cap, 'cpu cap');
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


function checkState(url, state, callback) {
    return client.get(url, function (err, req, res, data) {
        if (err)
            return callback(err);

        var body = JSON.parse(data);
        return callback(null, (body ? body.state === state : false));
    });
}


function waitForState(url, state, callback) {
    return checkState(url, state, function (err, ready) {
        if (err)
            return callback(err);

        if (!ready)
            return setTimeout(function () {
                waitForState(url, state, callback);
            }, 3000);

        return setTimeout(function () {
            callback(null);
        }, 20000);
    });
}

// --- Tests

test('setup', function (t) {
    common.setup(function (err, _client) {
        t.ifError(err);
        t.ok(_client, 'restify client');
        client = _client;
        ouuid = client.testUser.uuid;
        t.end();
    });
});


test('ListMachines (empty)', function (t) {
    client.get('/machines?owner_uuid=' + ouuid, function (err, req, res, data) {
        var body = JSON.parse(data);
        t.ifError(err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body);
        t.ok(Array.isArray(body), 'is array');
        t.ok(!body.length, 'empty array');
        t.end();
    });
});


// Need to stub creating a machince workflow API is not ready yet
test('ListMachines OK', function (t) {
    createMachine(client.ufds, ouuid, function (anErr, machine) {
        t.ifError(anErr);
        newMachine = machine;

        client.get('/machines?owner_uuid=' + ouuid,
          function (err, req, res, data) {
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
            t.end();
        });
    });
});


test('ListMachines by ram (empty)', function (t) {
    var path = '/machines?ram=32&owner_uuid=' + ouuid;

    client.get(path, function (err, req, res, data) {
        var body = JSON.parse(data);
        t.ifError(err);
        t.equal(res.statusCode, 200);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        t.ok(Array.isArray(body));
        t.ok(!body.length);
        t.end();
    });
});


test('ListMachines by ram OK', function (t) {
    var path = '/machines?ram=' + newMachine.ram + '&owner_uuid=' + ouuid;

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
        t.end();
    });
});


test('GetMachine (Not Found)', function (t) {
    var nouuid = uuid();
    var path = '/machines/' + nouuid + '?owner_uuid=' + ouuid;

    client.get(path, function (err, req, res, body) {
        t.equal(res.statusCode, 404);
        common.checkHeaders(t, res.headers);
        t.end();
    });
});


test('GetMachine OK', function (t) {
    var path = '/machines/' + muuid + '?owner_uuid=' + ouuid;

    client.get(path, function (err, req, res, data) {
        var body = JSON.parse(data);
        t.ifError(err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'machine ok');
        checkMachine(t, body);
        t.end();
    });
});


test('CreateMachine NotOK', function (t) {
    client.post('/machines', { owner_uuid: ouuid },
      function (err, req, res, data) {
        t.equal(res.statusCode, 409);
        common.checkHeaders(t, res.headers);
        t.end();
    });
});


test('CreateMachine OK', function (t) {
    var machine = {
        owner_uuid: ouuid,
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
          t.end();
    });
});


test('GetJob OK', function (t) {
    client.get(jobLocation, function (err, req, res, data) {
        var body = JSON.parse(data);
        t.ifError(err);
        t.equal(res.statusCode, 200, 'GetJob 200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'job ok');
        checkJob(t, body);
        t.end();
    });
});


test('Wait For Provisioned', TAP_CONF, function (t) {
    machineLocation = '/machines/' + newUuid;
    waitForState(machineLocation, 'running', function (err) {
        t.ifError(err);
        t.end();
    });
});


test('StopMachine OK', function (t) {
    client.post(machineLocation, { action: 'stop' },
      function (err, req, res, data) {
          t.ifError(err);
          t.equal(res.statusCode, 200, 'Stop 200 OK');
          common.checkHeaders(t, res.headers);
          t.ok(res.headers['job-location'], 'job location');

          jobLocation = res.headers['job-location'];
          t.end();
    });
});


test('Wait For Stopped', TAP_CONF, function (t) {
    waitForState(machineLocation, 'stopped', function (err) {
        t.ifError(err);
        t.end();
    });
});


test('StartMachine OK', function (t) {
    client.post(machineLocation, { action: 'start' },
      function (err, req, res, data) {
          t.ifError(err);
          t.equal(res.statusCode, 200, 'Start 200 OK');
          common.checkHeaders(t, res.headers);
          t.ok(res.headers['job-location'], 'job location');

          jobLocation = res.headers['job-location'];
          t.end();
    });
});


test('Wait For Started', TAP_CONF, function (t) {
    waitForState(machineLocation, 'running', function (err) {
        t.ifError(err);
        t.end();
    });
});


test('RebootMachine OK', function (t) {
    client.post(machineLocation, { action: 'reboot' },
      function (err, req, res, data) {
          t.ifError(err);
          t.equal(res.statusCode, 200, 'Reboot 200 OK');
          common.checkHeaders(t, res.headers);
          t.ok(res.headers['job-location'], 'job location');

          jobLocation = res.headers['job-location'];
          t.end();
    });
});


test('Wait For Rebooted', TAP_CONF, function (t) {
    waitForState(machineLocation, 'running', function (err) {
        t.ifError(err);
        t.end();
    });
});


test('DestroyMachine OK', function (t) {
    client.del(machineLocation, function (err, req, res, data) {
          t.ifError(err);
          t.equal(res.statusCode, 200, 'Destroy 200 OK');
          common.checkHeaders(t, res.headers);
          t.ok(res.headers['job-location'], 'job location');

          jobLocation = res.headers['job-location'];
          t.end();
    });
});


test('teardown', function (t) {
    var machineDn = 'machine=' + muuid + ', ' + client.testUser.dn;

    client.ufds.del(machineDn, function (anErr) {
        t.ifError(anErr);

        client.teardown(function (err) {
            t.ifError(err);
            t.end();
        });
    });
});
