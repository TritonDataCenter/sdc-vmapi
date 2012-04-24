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


/*
 * Validates if a string is a UUID
 */
function validUUID(uuid) {
    return UUID_RE.test(uuid);
}



/*
 * Validates if an alias is url compatible
 */
function validAlias(alias) {
    return ALIAS_RE.test(alias);
}



/*
 * Validates if a machine brand is either joyent or kvm
 */
function validBrand(brand) {
    return VALID_MACHINE_BRANDS.indexOf(brand) != -1;
}



/*
 * Validates if a param is a valid number
 */
function validNumber(param) {
    var number = parseInt(param);
    return (number > 0 ? true : false);
}



/*
 * Simple parser to get a machine owner by providing its dn.
 */
function machineOwner(dn) {
    var ouuid = '';
    if (!dn)
        return '';

    dn.split(',').forEach(function(val) {
        kv=val.split('=');
        // kv -> uuid=xyz
        if (kv[0].replace(/^\s+|\s+$/g, '') == 'uuid')
            ouuid = kv[1];
    });
    return ouuid;
}



/*
 * Returns an API machine response object
 */
function translateMachine(obj) {
    assert.ok(obj);

    var nics = [],
        tags = {},
        customer_metadata = {},
        internal_metadata = {};

    try { nics = JSON.parse(obj.nics); } catch (e) { }
    try { tags = JSON.parse(obj.tags); } catch (e) { }
    try { customer_metadata = JSON.parse(obj.customermetadata); } catch (e) {}
    try { internal_metadata = JSON.parse(obj.internalmetadata); } catch (e) {}

    var machine = {
        uuid: obj.uuid,
        server_uuid: obj.serveruuid || obj.server_uuid || '',
        alias: obj.alias || '',
        brand: obj.brand,
        ram: obj.ram,
        swap: obj.swap || '',
        disk: obj.disk || '',
        cpu_cap: obj.cpucap || obj.cpu_cap || '',
        cpu_shares: obj.cpushares || obj.cpu_shares || '',
        lightweight_processes: obj.lwps || obj.lightweight_processes || '',
        setup: obj.setup || '',
        status: obj.status || '',
        zfs_io_priority: obj.zfsiopriority || obj.zfs_io_priority || '',
        owner_uuid: machineOwner(obj.dn) || obj.owner_uuid,
        nics: nics,
        customer_metadata: customer_metadata || obj.customer_metadata,
        internal_metadata: internal_metadata || obj.internal_metadata,
        tags: tags
    };

    return machine;
}



/*
 * Returns an API job response object
 */
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



/*
 * Returns a UFDS machine object
 */
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
    machine.tags = JSON.stringify(m.tags);

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



/*
 * Validates a machine representation given a set of request parameters
 */
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
        throw new restify.InvalidArgumentError('%s is not a valid machine ' +
                                               'brand', params.brand);

    if (!params.ram)
        throw new restify.MissingParameterError('Machine RAM is required');

    if (!validNumber(params.ram))
        throw new restify.InvalidArgumentError('%s is not a valid number for ' +
                                               'RAM', params.ram);

    if (params.cpu_shares && !validNumber(params.cpu_shares))
        throw new restify.InvalidArgumentError('%s is not a valid number for ' +
                                              'CPU shares', params.ram);

    return true;
}



/*
 * Sets default attributes for a machine on things that depend on
 * RAM or disk for example
 */
function setDefaultValues(params) {
    assert.ok(params.ram)
    params.ram = parseInt(params.ram);

    if (!params.swap)
        params.swap = params.ram * 2;

    if (!params.cpu_shares) {
        if (params.ram > 128)
            params.cpu_shares = Math.floor(params.ram / 128);
        else
            params.cpu_shares = 1;
    }

    return;
}


/*
 * Shallow comparison of two objects. ignoreKeys can be an array of keys that
 * the comparison should ignore if needed
 */
function shallowEqual(a, b, ignoreKeys) {
    var akeys = Object.keys(a);
    var bkeys = Object.keys(b);

    if (!ignoreKeys) ignoreKeys = [];
    if (akeys.length != bkeys.length)
        return false;

    for (var i = 0; i < akeys.length; i++) {
        var key = akeys[i];

        if (ignoreKeys.indexOf(key) == -1 && (a[key] != b[key]))
            return false;
    }

    return true;
}



module.exports = {

    validUUID: validUUID,
    validAlias: validAlias,
    validateMachine: validateMachine,
    setDefaultValues: setDefaultValues,
    translateJob: translateJob,
    translateMachine: translateMachine,
    machineToUfds: machineToUfds,
    shallowEqual: shallowEqual,
    machineOwner: machineOwner

};
