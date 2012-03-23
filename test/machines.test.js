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


// --- Helpers

function checkMachine(t, machine) {
  t.ok(machine);
  t.ok(machine.uuid);
  t.ok(machine.alias);
  t.ok(machine.type);
  t.ok(machine.ram);
  t.ok(machine.swap);
  t.ok(machine.disk);
  t.ok(machine.cpu_cap);
  t.ok(machine.cpu_shares);
  t.ok(machine.lightweight_processes);
  t.ok(machine.setup);
  t.ok(machine.status);
  t.ok(machine.zfs_io_priority);
  t.ok(machine.owner_uuid);
}

// --- Tests

test('setup', function (t) {
  common.setup(function (err, _client) {
    t.ifError(err);
    t.ok(_client);
    client = _client;
    ouuid = client.testUser.uuid;
    t.end();
  });
});


test('ListMachines (empty)', function (t) {
  client.get('/machines?owner_uuid=' + ouuid, function (err, req, res, data) {
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


// Need to stub creating a machince workflow API is not ready yet
test('ListMachines OK', function (t) {
  createMachine(client.ufds, ouuid, function (err, machine) {
    t.ifError(err);
    newMachine = machine;

    client.get('/machines?owner_uuid=' + ouuid, function (err, req, res, data) {
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
    t.equal(res.statusCode, 200);
    common.checkHeaders(t, res.headers);
    t.ok(body);
    checkMachine(t, body);
    t.end();
  });
});


test('teardown', function (t) {
  var machineDn = 'machineid=' + muuid + ', ' + client.testUser.dn;

  client.ufds.del(machineDn, function (err) {
    t.ifError(err);

    client.teardown(function (err) {
      t.ifError(err);
      t.end();
    });
  });
});
