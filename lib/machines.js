/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var uuid = require('node-uuid');
var restify = require('restify');
var ldap = require('ldapjs');

function Machines(options) {
  this.ufds = options.ufds;
}

var machines = {};

Machines.prototype.listMachines = function(req, res, next) {
  req.log.info('ListMachines start');

  var machinesArray = [];
  Object.keys(machines).forEach(function (u) { machinesArray.push(machines[u]); });
  res.send(machinesArray);
  return next();
}


Machines.prototype.createMachine = function(req, res, next) {
  req.log.info('CreateMachine start');

  var newUuid = uuid();
  var newMachine = {'uuid': newUuid};
  machines[newUuid] = newMachine;
  res.send(newMachine);
  return next();
}


Machines.prototype.getMachine = function(req, res, next) {
  req.log.info('GetMachine start');

  var machine = machines[req.params.uuid];
  if (!machine) {
    return next(new restify.ResourceNotFoundError('No such machine.'));
  }

  res.send(machine);
  return next();
}


module.exports = Machines;