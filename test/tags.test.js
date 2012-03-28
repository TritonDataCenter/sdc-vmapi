// Copyright 2011 Joyent, Inc.  All rights reserved.

var test = require('tap').test;
var uuid = require('node-uuid');

var common = require('./common');
var createMachine = require('../tools/create_machine');


// --- Globals

var client;
var stringClient;
var newMachine;
var muuid;
var ouuid;


// --- Helpers


// --- Tests

test('setup', function (t) {
  common.setup(function (err, _client) {
    t.ifError(err);
    t.ok(_client);
    client = _client;
    // stringClient = _stringClient;
    ouuid = client.testUser.uuid;
    t.end();
  });
});


test('ListTags (empty)', function (t) {
  createMachine(client.ufds, ouuid, function (err, machine) {
    t.ifError(err);
    newMachine = machine;
    muuid = newMachine.uuid;

    var path = '/machines/' + muuid + '/tags?owner_uuid=' + ouuid;

    client.get(path, function (err, req, res, data) {
      body = JSON.parse(data);
      t.ifError(err);
      t.equal(res.statusCode, 200, "200 OK");
      common.checkHeaders(t, res.headers);
      t.ok(body, "body");
      t.ok(!Object.keys(body).length, "empty body");
      t.end();
    });
  });
});


test('AddTags OK', function (t) {
  var path = '/machines/' + muuid + '/tags?owner_uuid=' + ouuid;
  var query = 'role=database&group=deployment';

  client.post(path, query, function (err, req, res, data) {
    body = JSON.parse(data);
    t.ifError(err);
    t.equal(res.statusCode, 200);
    common.checkHeaders(t, res.headers);
    t.ok(body);
    t.end();
  });
});


test('GetTag OK', function (t) {
  var path = '/machines/' + muuid + '/tags/role?owner_uuid=' + ouuid;

  client.get(path, function (err, req, res, data) {
    t.ifError(err);
    t.equal(res.statusCode, 200);
    common.checkHeaders(t, res.headers);
    t.ok(body);
    t.equal(data, 'database');
    t.end();
  });
});


test('DeleteTag OK', function (t) {
  var path = '/machines/' + muuid + '/tags/role?owner_uuid=' + ouuid;

  client.del(path, function (err, req, res) {
    t.ifError(err);
    t.equal(res.statusCode, 204);
    common.checkHeaders(t, res.headers);
    t.end();
  });
});


test('DeleteTags OK', function (t) {
  var path = '/machines/' + muuid + '/tags?owner_uuid=' + ouuid;

  client.del(path, function (err, req, res) {
    t.ifError(err);
    t.equal(res.statusCode, 204);
    common.checkHeaders(t, res.headers);
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
