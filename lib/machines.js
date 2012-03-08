/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var assert = require('assert');
var uuid = require('node-uuid');
var restify = require('restify');
var ldap = require('ldapjs');
var sprintf = require('sprintf').sprintf;


var OWNER_UUID = "930896af-bf8c-48d4-885c-6573a94b1853";
var SUFFIX = 'o=smartdc';

var USERS = 'ou=users, ' + SUFFIX;
var USER_FMT = 'uuid=%s, ' + USERS;
var MACHINE_FMT = 'machineid=%s, ' + USER_FMT;


var UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
var ALIAS_RE = /^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9\-]*[A-Za-z0-9])$/;


function validUUID(uuid) {
  return UUID_RE.test(uuid);
}


function _translateMachine(req, obj) {
  assert.ok(obj);
  req.log.debug("Received machine: ", obj);

  var machine = {
    uuid: obj.machineid,
    alias: obj.alias,
    ram: obj.ram,
    swap: obj.swap,
    disk: obj.disk,
    cpu_cap: obj.cpucap,
    cpu_shares: obj.cpushares,
    lightweight_processes: obj.lwps,
    setup: obj.setup,
    status: obj.status,
    zfs_io_priority: obj.zfsiopriority,
    owner_uuid: obj._owner
  };

  return machine;
}


module.exports = {

  listMachines: function(req, res, next) {
    req.log.trace('ListMachines start');
    var owner_uuid = req.params.owner_uuid;

    if (!owner_uuid)
      return next(new restify.ConflictError('Owner UUID is required'));

    var baseDn = sprintf(USER_FMT, owner_uuid);
    var options = {
      scope: "one",
      filter: "(objectclass=machine)"
    };

    req.ufds.search(baseDn, options, function(err, results) {
      if (err) {
        return next(new restify.InternalErrorError(err));
      }

      var machines = [];

      results.on('searchEntry', function(entry) {
        machines.push(_translateMachine(req, entry.object));
      });

      results.on('error', function(err) {
        return next(new restify.InternalErrorError(err));
      });

      results.on('end', function() {
        res.send(200, machines);
        return next();
      });
    });
  },



  getMachine: function(req, res, next) {
    req.log.trace('GetMachine start');
    var owner_uuid = req.params.owner_uuid;
    var uuid = req.params.uuid;

    if (!owner_uuid)
      return next(new restify.ConflictError('Owner UUID is required'));

    if (!validUUID(uuid))
      return next(new restify.ConflictError('Machine UUID is not a valid UUID'));

    var baseDn = sprintf(MACHINE_FMT, uuid, owner_uuid);
    var options = {
      filter: "(objectclass=machine)"
    };

    req.ufds.search(baseDn, options, function(err, results) {
      if (err) {
        return next(new restify.InternalErrorError(err));
      }

      var machine;

      results.on('searchEntry', function(entry) {
        machine = _translateMachine(req, entry.object);
      });

      results.on('error', function(err) {
        return next(new restify.InternalErrorError(err));
      });

      results.on('end', function() {
        res.send(200, machine);
        return next();
      });
    });
  }

};
