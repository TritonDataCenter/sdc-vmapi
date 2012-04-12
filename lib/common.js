/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var assert = require('assert');
var restify = require('restify');

var UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/*JSSTYLED*/
var ALIAS_RE = /^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9\-]*[A-Za-z0-9])$/;

var VALID_MACHINE_BRANDS = [
  'joyent',
  'kvm'
];


function validUUID(uuid) {
  return UUID_RE.test(uuid);
}

function validAlias(alias) {
  return ALIAS_RE.test(alias);
}

function validBrand(brand) {
  return VALID_MACHINE_BRANDS.indexOf(brand) != -1;
}

function validNumber(param) {
  var number = parseInt(param);
  return (number > 0 ? true : false);
}


function translateMachine(obj) {
  assert.ok(obj);

  var nics = [],
      customer_metadata = {},
      internal_metadata = {};

  try { nics = JSON.parse(obj.nics); } catch (e) { }
  try { customer_metadata = JSON.parse(obj.customermetadata); } catch (e) {}
  try { internal_metadata = JSON.parse(obj.internalmetadata); } catch (e) {}

  var machine = {
    uuid: obj.uuid,
    alias: obj.alias || '',
    brand: obj.brand,
    ram: obj.ram,
    swap: obj.swap || '',
    disk: obj.disk || '',
    cpu_cap: obj.cpucap || '',
    cpu_shares: obj.cpushares || '',
    lightweight_processes: obj.lwps || '',
    setup: obj.setup || '',
    status: obj.status || '',
    zfs_io_priority: obj.zfsiopriority || '',
    owner_uuid: obj._owner || obj.owner_uuid,
    nics: nics,
    customer_metadata: customer_metadata,
    internal_metadata: internal_metadata
  };

  return machine;
}


function translateJob(obj) {
  assert.ok(obj);

  var job = {
    name: obj.name,
    uuid: obj.uuid,
    execution: obj.execution,
    params: obj.params,
    info: obj.info,
    exec_after: obj.exec_after,
    created_at: obj.created_at,
    timeout: obj.timeout,
    chain_results: obj.chain_results
  };

  return job;
}


function machineToUfds(m) {
  var machine = {};

  machine.uuid = m.zonename;
  machine.brand = m.brand;

  machine.ram = m.max_physical_memory;
  machine.swap = m.max_swap;
  machine.disk = m.quota;
  machine.lwps = m.max_lwps;
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

  if (machine.alias)
    machine.alias = m.alias;

  if (machine.cpucap)
    machine.cpucap = m.cpucap;

  return machine;
}


function validateMachine(params) {
  if (!params.owner_uuid)
    throw new restify.MissingParameterError('Owner UUID is required');

  if (!validUUID(params.owner_uuid))
    throw new restify.ConflictError('Owner UUID is not a valid UUID');

  if (!params.dataset_uuid)
    throw new restify.MissingParameterError('Dataset UUID is required');

  if (!validUUID(params.dataset_uuid))
    throw new restify.ConflictError('Dataset UUID is not a valid UUID');

  if (!params.brand)
    throw new restify.MissingParameterError('Machine brand is required');

  if (!validBrand(params.brand))
    throw new restify.InvalidArgumentError('%s is not a valid machine brand',
                                            params.brand);

  if (!params.ram)
    throw new restify.MissingParameterError('Machine RAM is required');

  if (!validNumber(params.ram))
    throw new restify.InvalidArgumentError('%s is not a valid number for RAM',
                                            params.ram);

  return true;
}


module.exports = {

  validUUID: validUUID,
  validAlias: validAlias,
  validateMachine: validateMachine,
  translateJob: translateJob,
  translateMachine: translateMachine,
  machineToUfds: machineToUfds

};
