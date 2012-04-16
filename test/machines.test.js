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


// --- Helpers

function checkMachine(t, machine) {
    t.ok(machine.uuid, 'uuid');
    t.ok(machine.alias, 'alias');
    t.ok(machine.brand, 'brand');
    t.ok(machine.ram, 'ram');
    t.ok(machine.swap, 'swap');
    t.ok(machine.disk, 'disk');
    t.ok(machine.cpu_cap, 'cpu cap');
    t.ok(machine.cpu_shares, 'cpu shares');
    t.ok(machine.lightweight_processes, 'lwps');
    t.ok(machine.setup, 'setup');
    t.ok(machine.status, 'status');
    t.ok(machine.zfs_io_priority, 'zfs io');
    t.ok(machine.owner_uuid, 'owner uuid');
}

function checkJob(t, job) {
    t.ok(job.uuid, 'uuid');
    t.ok(job.name, 'name');
    t.ok(job.execution, 'execution');
    t.ok(job.params, 'params');
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
        body = JSON.parse(data);
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
    createMachine(client.ufds, ouuid, function (err, machine) {
        t.ifError(err);
        newMachine = machine;

        client.get('/machines?owner_uuid=' + ouuid,
          function (err, req, res, data) {
            body = JSON.parse(data);
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
        body = JSON.parse(data);
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
        body = JSON.parse(data);
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
        body = JSON.parse(data);
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
        dataset_uuid: '28445220-6eac-11e1-9ce8-5f14ed22e782',
        brand: 'joyent',
        ram: 64
    };

    client.post('/machines', machine,
      function (err, req, res, data) {
          body = JSON.parse(data);
          t.ifError(err);
          t.equal(res.statusCode, 201, '201 Created');
          common.checkHeaders(t, res.headers);
          t.ok(body, 'machine ok');
          t.ok(res.headers['job-location'], 'job location');

          jobLocation = res.headers['job-location'];
          t.end();
    });
});


test('GetJob OK', function (t) {
    client.get(jobLocation, function (err, req, res, data) {
        body = JSON.parse(data);
        t.ifError(err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'job ok');
        checkJob(t, body);
        t.end();
    });
});


test('teardown', function (t) {
    var machineDn = 'uuid=' + muuid + ', ' + client.testUser.dn;

    client.ufds.del(machineDn, function (err) {
        t.ifError(err);

        client.teardown(function (err) {
            t.ifError(err);
            t.end();
        });
    });
});
