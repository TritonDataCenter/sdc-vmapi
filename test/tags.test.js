// Copyright 2011 Joyent, Inc.  All rights reserved.

var test = require('tap').test;
var uuid = require('node-uuid');

var common = require('./common');
var createMachine = require('../tools/create_machine');


///--- Globals

var client;
var newMachine;
var muuid;
var ouuid;


///--- Helpers


///--- Tests

test('setup', function(t) {
  common.setup(function(err, _client) {
    t.ifError(err);
    t.ok(_client);
    client = _client;
    ouuid = client.testUser.uuid;
    t.end();
  });
});


test('ListTags (empty)', function(t) {
  createMachine(client.ufds, ouuid, function(err, machine) {
    t.ifError(err);
    newMachine = machine;
    muuid = newMachine.machineid;

    var path = '/machines/' + muuid + '/tags?owner_uuid=' + ouuid;

    client.get(path, function(err, req, res, body) {
      t.ifError(err);
      t.equal(res.statusCode, 200);
      common.checkHeaders(t, res.headers);
      t.ok(body);
      t.ok(!Object.keys(body).length);
      t.end();
    });
  });
});


// test('SetTag OK', function(t) {
//   var tagKey = "role";
//   var tagValue = "db";
//   var path = '/machines/' + muuid + '/tags/' + tagKey + '?owner_uuid=' + ouuid;
//
//   client.put(path, { value: tagValue }, function(err, req, res, body) {
//     t.ifError(err);
//     t.equal(res.statusCode, 200);
//     common.checkHeaders(t, res.headers);
//     t.ok(body);
//     t.ok(!Object.keys(body).length);
//     t.end();
//   });
// });


test('teardown', function(t) {
  var machineDn = "machineid=" + muuid + ", " + client.testUser.dn;

  client.ufds.del(machineDn, function(err) {
    t.ifError(err);

    client.teardown(function(err) {
      t.ifError(err);
      t.end();
    });
  });
});
