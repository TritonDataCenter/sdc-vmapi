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

function validAlias(alias) {
  return ALIAS_RE.test(alias);
}


function _translateMachine(req, obj) {
  assert.ok(obj);
  req.log.trace("Received machine: ", obj);

  var machine = {
    uuid: obj.machineid,
    alias: obj.alias,
    type: obj.type,
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
    var filter = "";

    if (owner_uuid) {
      if (!validUUID(owner_uuid))
        return next(new restify.ConflictError('Owner UUID is not a valid UUID'));

      baseDn = sprintf(USER_FMT, owner_uuid);
    } else {
      baseDn = USERS;
    }

    if (req.params.type)
      filter += "(type=" + req.params.type + ")";

    if (req.params.alias)
      filter += "(alias=" + req.params.alias + ")";

    if (req.params.status)
      filter += "(status=" + req.params.status + ")";

    if (req.params.ram)
      filter += "(ram=" + req.params.ram + ")";

    var options = {
      scope: "sub",
      filter: "(&(objectclass=machine)" + filter + ")"
    };

    req.ufds.search(USERS, options, function(err, items) {
      if (err)
        return next(err);

      var machines = [];

      for (var i = 0; i < items.length; i++)
        machines.push(_translateMachine(req, items[i]));

      if (machines.length == 0)
        res.send(204);
      else
        res.send(200, machines);

      return next();
    });
  },



  getMachine: function(req, res, next) {
    req.log.trace('GetMachine start');
    var baseDn;
    var uuid = req.params.uuid;
    var owner_uuid = req.params.owner_uuid;

    if (!validUUID(uuid))
      return next(new restify.ConflictError('Machine UUID is not a valid UUID'));

    if (owner_uuid) {
      if (!validUUID(owner_uuid))
        return next(new restify.ConflictError('Owner UUID is not a valid UUID'));

      baseDn = sprintf(USER_FMT, owner_uuid);
    } else {
      baseDn = USERS;
    }

    var options = {
      scope: "sub",
      filter: "(&(objectclass=machine)(machineid=" + uuid + "))"
    };

    req.ufds.search(baseDn, options, function(err, items) {
      if (err)
        return next(err);

      if (items.length == 0)
        return next(new restify.ResourceNotFoundError('Machine not found'));
      else
        res.send(200, _translateMachine(req, items[0]));

      return next();
    });
  }

};
