/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var assert = require('assert');

var UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
var ALIAS_RE_STR = '^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9])\.)*' +
                   '([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9\-]*[A-Za-z0-9])$';

var ALIAS_RE = new RegExp(ALIAS_RE_STR);

function validUUID(uuid) {
  return UUID_RE.test(uuid);
}

function validAlias(alias) {
  return ALIAS_RE.test(alias);
}

function translateMachine(obj) {
  assert.ok(obj);

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

  validUUID: validUUID,
  validAlias: validAlias,
  translateMachine: translateMachine

};
