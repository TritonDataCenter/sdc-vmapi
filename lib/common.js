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
 * Shallow clone
 */
function clone(obj) {
    if (null == obj || 'object' != typeof obj)
        return obj;

    var copy = obj.constructor();

    for (var attr in obj) {
        if (obj.hasOwnProperty(attr))
            copy[attr] = obj[attr];
    }
    return copy;
}



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

    dn.split(',').forEach(function (val) {
        var kv = val.split('=');
        // kv -> uuid=xyz
        if (kv[0].replace(/^\s+|\s+$/g, '') == 'uuid')
            ouuid = kv[1];
    });
    return ouuid;
}



/*
 * Returns a univeral machine object. The only special case is when the
 * machine object comes from UFDS. Here we know that the owner_uuid can be
 * parsed from the dn. If not, we call obj.owner_uuid
 *
 * You can pass the fullObject flag to ignore attributes that have not been set.
 * This is useful for machine update operations when you want to modify 'these'
 * properties only
 */
function translateMachine(obj, fullObject) {
    assert.ok(obj);
    if (fullObject === undefined)
        fullObject = false;

    assert.equal(typeof(fullObject), 'boolean');

    try {
        if (typeof(obj.nics) == 'string')
            obj.nics = JSON.parse(obj.nics);
    } catch (e) { }

    try {
        if (typeof(obj.tags) == 'string')
            obj.tags = JSON.parse(obj.tags);
    } catch (e) { }

    try {
        if (typeof(obj.customer_metadata) == 'string')
            obj.customer_metadata = JSON.parse(obj.customer_metadata);
    } catch (e) {}

    try {
        if (typeof(obj.internal_metadata) == 'string')
            obj.internal_metadata = JSON.parse(obj.internal_metadata);
    } catch (e) {}

    var machine = {
        uuid: obj.uuid,
        brand: obj.brand,
        dataset_uuid: obj.dataset_uuid,
        server_uuid: obj.server_uuid,
        alias: obj.alias,
        ram: obj.ram,
        max_physical_memory: obj.max_physical_memory,
        max_swap: obj.max_swap,
        quota: obj.quota,
        cpu_cap: obj.cpu_cap,
        cpu_shares: obj.cpu_shares,
        max_lwps: obj.max_lwps,
        create_timestamp: obj.create_timestamp,
        destroyed: obj.destroyed,
        last_modified: obj.last_modified,
        zone_state: obj.zone_state,
        state: obj.state,
        zpool: obj.zpool,
        zfs_io_priority: obj.zfs_io_priority,
        owner_uuid: machineOwner(obj.dn) || obj.owner_uuid,
        nics: obj.nics,
        customer_metadata: obj.customer_metadata,
        internal_metadata: obj.internal_metadata,
        tags: obj.tags
    };

    var key;

    if (fullObject) {
        if (machine.ram === undefined &&
            machine.max_physical_memory !== undefined) {
            machine.ram = machine.max_physical_memory;
        }

        Object.keys(machine).forEach(function (key) {
            if (machine[key] === undefined) {
                var value;
                if (key == 'customer_metadata' || key == 'internal_metadata' ||
                    key == 'tags') {
                    machine[key] = {};
                } else if (key == 'nics') {
                    machine[key] = [];
                } else {
                    delete machine[key];
                }
            }
        });
    } else {
        machine = JSON.parse(JSON.stringify(machine));
    }

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
 * Returns a UFDS machine object. It doesn't do anything special other than
 * stringifying arrays and hashes
 */
function machineToUfds(machine) {
    var copy = clone(machine);
    copy.nics = JSON.stringify(copy.nics);
    copy.tags = JSON.stringify(copy.tags);
    copy.internal_metadata = JSON.stringify(copy.internal_metadata);
    copy.customer_metadata = JSON.stringify(copy.customer_metadata);
    return copy;
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
    assert.ok(params.ram);
    params.ram = parseInt(params.ram);

    if (!params.max_swap)
        params.max_swap = params.ram * 2;

    if (!params.cpu_shares) {
        if (params.ram > 128)
            params.cpu_shares = Math.floor(params.ram / 128);
        else
            params.cpu_shares = 1;
    }
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
