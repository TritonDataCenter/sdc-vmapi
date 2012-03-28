/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var assert = require('assert');

var UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/*JSSTYLED*/
var ALIAS_RE = /^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9\-]*[A-Za-z0-9])$/;

function validUUID(uuid) {
  return UUID_RE.test(uuid);
}

function validAlias(alias) {
  return ALIAS_RE.test(alias);
}

function translateMachine(obj) {
  assert.ok(obj);

  var machine = {
    uuid: obj.uuid,
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
    owner_uuid: obj._owner,
    nics: JSON.parse(obj.nics),
    customer_metadata: JSON.parse(obj.customermetadata),
    internal_metadata: JSON.parse(obj.internalmetadata)
  };

  return machine;
}


function machineToUfds(m) {
  var machine = {};

  var type = (m.brand == 'joyent' ? 'zone' : 'vm');

  machine.uuid = m.zonename;
  machine.alias = m.alias;
  machine.type = type;
  machine.brand = m.brand;

  machine.ram = m.max_physical_memory;
  machine.swap = m.max_swap;
  machine.disk = m.quota;
  machine.lwps = m.max_lwps;
  machine.cpucap = m.cpu_cap;
  machine.cpushares = m.cpu_shares;
  machine.zfsiopriority = m.zfs_io_priority;

  machine.zonepath = m.zonepath;
  machine.datasetuuid = m.dataset_uuid;
  machine.serveruuid = m.compute_node_uuid;
  machine.autoboot = m.autoboot;
  machine.nics = JSON.stringify(m.nics);

  machine.status = m.state;
  machine.setup = m.create_timestamp;

  machine.internalmetadata = JSON.stringify(m.internal_metadata);
  machine.customermetadata = JSON.stringify(m.customer_metadata);

  return machine;
}


module.exports = {

  validUUID: validUUID,
  validAlias: validAlias,
  translateMachine: translateMachine,
  machineToUfds: machineToUfds

};
