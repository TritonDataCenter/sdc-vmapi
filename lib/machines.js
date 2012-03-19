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

var common = require('./common');

var SUFFIX = 'o=smartdc';

var USERS = 'ou=users, ' + SUFFIX;
var USER_FMT = 'uuid=%s, ' + USERS;
var MACHINE_FMT = 'machineid=%s, ' + USER_FMT;

var VALID_MACHINE_ACTIONS = [
  'start',
  'stop',
  'reboot',
  'resize'
];


function validAction(action) {
  return VALID_MACHINE_ACTIONS.indexOf(action) != -1;
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



/*
 * GET /machines/:uuid
 *
 * Returns a list of machines according the specified search filter. The valid
 * query options are: owner_uuid, type, alias, status, and ram.
 */
function listMachines(req, res, next) {
  req.log.trace('ListMachines start');
  var owner_uuid = req.params.owner_uuid;
  var filter = "";

  if (owner_uuid) {
    if (!common.validUUID(owner_uuid))
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

  req.ufds.search(baseDn, options, function(err, items) {
    if (err)
      return next(err);

    var machines = [];

    for (var i = 0; i < items.length; i++)
      machines.push(_translateMachine(req, items[i]));

    res.send(200, machines);

    return next();
  });
}



/*
 * GET /machines/:uuid
 */
function getMachine(req, res, next) {
  req.log.trace('GetMachine start');
  res.send(200, _translateMachine(req, req.machine));
}



/*
 * POST /machines/:uuid
 */
function updateMachine(req, res, next) {
  req.log.trace('UpdateMachine start');
  var method;
  var action = req.params.action;

  if (!action)
    return next(new restify.MissingParameterError('action is required'));

  if (!validAction(action))
    return next(new restify.InvalidArgumentError('%s is not a valid action',
                                           req.params.action));

  switch (action) {
    case "start":
      method = startMachine;
      break;
    case "stop":
      method = stopMachine;
      break;
    case "reboot":
      method = rebootMachine;
      break;
    case "resize":
      method = resizeMachine;
      break;
  }

  method.call(this, req, res, next);
}



/*
 * Starts a machine with ?action=start
 */
function startMachine(req, res, next) {
  res.send(202);
  return next();
}



/*
 * Stops a machine with ?action=stop
 */
function stopMachine(req, res, next) {
  res.send(202);
  return next();
}



/*
 * Reboots a machine with ?action=reboot
 */
function rebootMachine(req, res, next) {
  res.send(202);
  return next();
}



/*
 * Resizes a machine with ?action=resize
 */
function resizeMachine(req, res, next) {
  res.send(202);
  return next();
}



/*
 * Mounts machine actions as server routes
 */
function mount(server, before) {
  server.get({ path: '/machines', name: 'ListMachines' }, before, listMachines);

  server.get({ path: '/machines/:uuid', name: 'GetMachine' },
               before, getMachine);

  server.post({ path: '/machines/:uuid', name: 'UpdateMachine' },
                before, updateMachine);
}


///--- Exports

module.exports = {
    mount: mount
};
