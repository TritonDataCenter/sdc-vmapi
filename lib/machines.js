/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var uuid = require('node-uuid');
var restify = require('restify');
var ldap = require('ldapjs');
var sprintf = require('sprintf').sprintf;


var OWNER_UUID = "930896af-bf8c-48d4-885c-6573a94b1853";
var SUFFIX = 'o=smartdc';

var USERS = 'ou=users, ' + SUFFIX;
var USER_FMT = 'uuid=%s, ' + USERS;
var MACHINE_FMT = 'machineid=%s, ' + USER_FMT;


module.exports = {

  listMachines: function(req, res, next) {
    req.log.trace('ListMachines start');
    var owner_uuid = req.params.owner_uuid;

    if (!owner_uuid)
      return next(new restify.ConflictError('Owner UUID is required'));

    var baseDn = sprintf(USER_FMT, owner_uuid);
    var options = {
      scope: "sub",
      filter: "(objectclass=machine)"
    };

    req.ufds.search(baseDn, options, function(err, results) {
      if (err) {
        return next(new restify.InternalErrorError(err));
      }

      var entries = [];

      results.on('searchEntry', function(entry) {
        entries.push(entry.object);
      });

      results.on('error', function(err) {
        return next(new restify.InternalErrorError(err));
      });

      results.on('end', function() {
        res.send(200, entries);
        return next();
      });
    });

  },


  createMachine: function(req, res, next) {
    req.log.trace('CreateMachine start');

    var newUuid = uuid();
    var newMachine = {'uuid': newUuid};
    machines[newUuid] = newMachine;
    res.send(newMachine);
    return next();
  },


  getMachine: function(req, res, next) {
    req.log.trace('GetMachine start');

    var machine = machines[req.params.uuid];
    if (!machine) {
      return next(new restify.ResourceNotFoundError('No such machine.'));
    }

    res.send(machine);
    return next();
  }

};
