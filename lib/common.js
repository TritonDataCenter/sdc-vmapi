/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var assert = require('assert');
var restify = require('restify');
var util = require('util');

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

exports.clone = clone;


/*
 * Validates if a string is a UUID
 */
exports.validUUID = function(uuid) {
    return UUID_RE.test(uuid);
}



/*
 * Validates if a comma separated string contains UUIDs
 */
exports.validUUIDs = function(object) {
    var array;
    var uuid;

    if (Array.isArray(object)) {
        array = object;
    } else if (typeof (object) === 'string') {
        array = object.split(',');
    } else {
        return false;
    }

    for (var i = 0; i < array.length; i++) {
        uuid = array[i];
        if (!UUID_RE.test(uuid))
            return false;
    }

    return true;
}



/*
 * Validates if an alias is url compatible
 */
exports.validAlias = function(alias) {
    return ALIAS_RE.test(alias);
}



/*
 * Validates if a machine brand is either joyent or kvm
 */
exports.validBrand = function(brand) {
    return VALID_MACHINE_BRANDS.indexOf(brand) != -1;
}



/*
 * Validates if a param is a valid number
 */
exports.validNumber = function(param) {
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

exports.machineOwner = machineOwner;


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
                    value = {};
                } else if (key == 'nics') {
                    value = [];
                } else {
                    value = '';
                }

                machine[key] = value;
            }
        });
    } else {
        Object.keys(machine).forEach(function (key) {
            if (machine[key] === undefined || machine[key] === null
                || machine[key] == '') {
                delete machine[key];
            }
        });
    }

    return machine;
}

exports.translateMachine = translateMachine;



/*
 * Returns an API job response object
 */
exports.translateJob = function(obj) {
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
exports.machineToUfds = function(machine) {
    var copy = translateMachine(clone(machine));

    if (copy.nics) {
        copy.nics = JSON.stringify(copy.nics);
    }

    copy.tags = JSON.stringify(copy.tags);
    copy.internal_metadata = JSON.stringify(copy.internal_metadata);
    copy.customer_metadata = JSON.stringify(copy.customer_metadata);

    return copy;
}



/*
 * Validates a machine representation given a set of request parameters
 */
exports.validateMachine = function(params) {
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

    if (params.networks && !validUUIDs(params.networks))
        throw new restify.InvalidArgumentError('\'%s\' are not valid UUIDs for ' +
                                                'Networks', params.networks);

    return true;
}



/*
 * Validates a resize request and returns the parameters needed for it. Right
 * now the following attributes can be changed:
 * - alias
 * - owner_uuid
 * - tags
 * - customer_metadata
 * - internal_metadata
 * - max_physical_memory
 * - ram
 * - quota
 * - max_swap
 * - cpu_cap
 * - max_lwps
 * - zfs_io_priority
 */
exports.validateUpdate = function(obj) {
    var params = {};

    var properties = {
        max_physical_memory: 'Max. Physical Memory',
        ram: 'RAM',
        max_swap: 'Swap',
        quota: 'Quota',
        cpu_cap: 'CPU Cap',
        max_lwps: 'Max. Lightweight Processes',
        zfs_io_priority: 'ZFS IO  Priority'
    };

    Object.keys(properties).forEach(function (prop) {
        if (obj[prop]) {
            if (validNumber(obj[prop])) {
                params[prop] = obj[prop];
            } else {
                throw new restify.ConflictError('Machine ' +
                properties[prop] + ' is invalid');
            }
        }
    });

    if (obj.owner_uuid) {
        if (typeof(obj.owner_uuid) === 'string' && validUUID(obj.owner_uuid)) {
            params.owner_uuid = obj.owner_uuid;
        } else {
            throw new restify.ConflictError('Owner UUID ' + obj.owner_uuid +
                                            ' is invalid');
        }
    }

    if (obj.alias) {
        if (typeof(obj.alias) === 'string' && validAlias(obj.alias)) {
            params.alias = obj.alias;
        } else {
            throw new restify.ConflictError('Alias ' + obj.owner_uuid +
                                            ' is invalid');
        }
    }

    if (obj.customer_metadata) {
        if (typeof(obj.customer_metadata) === 'object') {
            params['set_customer_metadata'] = obj.customer_metadata;
        } else {
            throw new restify.ConflictError('Customer metadata ' +
                                        obj.customer_metadata + ' is invalid');
        }
    }

    if (obj.internal_metadata) {
        if (typeof(obj.internal_metadata) === 'object') {
            params['set_internal_metadata'] = obj.internal_metadata;
        } else {
            throw new restify.ConflictError('Internal metadata ' +
                                        obj.internal_metadata + ' is invalid');
        }
    }

    if (obj.tags) {
        if (typeof(obj.tags) === 'object') {
            params['set_tags'] = obj.tags;
        } else {
            throw new restify.ConflictError('Tags ' + obj.tags + ' is invalid');
        }
    }

    if (Object.keys(params).length == 0)
        throw new restify.MissingParameterError('You have not provided any ' +
                'parameters for machine update');

    return params;
}



/*
 * Sets default attributes for a machine on things that depend on
 * RAM or disk for example
 */
exports.setDefaultValues = function(params) {
    assert.ok(params.ram);
    params.ram = parseInt(params.ram);

    if (!params.max_physical_memory)
        params.max_physical_memory = params.ram;

    if (!params.max_swap)
        params.max_swap = params.ram * 2;

    if (!params.cpu_shares) {
        if (params.ram > 128)
            params.cpu_shares = Math.floor(params.ram / 128);
        else
            params.cpu_shares = 1;
    }

    if (params.networks && typeof (params.networks) === 'string')
        params.networks = params.networks.split(',');
}


/*
 * Shallow comparison of two objects. ignoreKeys can be an array of keys that
 * the comparison should ignore if needed
 */
exports.shallowEqual = function(a, b, ignoreKeys) {
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



/*
 * Creates a set_metada object
 */
exports.addMetadata = function(mdataKey, params) {
    var setMdata = {};
    var mdata = {};
    var numKeys = 0;

    Object.keys(params).forEach(function (key) {
        if (key != 'uuid' && key != 'owner_uuid' && key != 'metadata') {
            mdata[key] = params[key];
            numKeys++;
        }
    });

    if (numKeys == 0) {
        return callback(
          new restify.InvalidArgumentError('At least one ' + mdataKey +
          ' key must be provided'),
          null);
    }

    // This will give you something like this:
    // { set_customer_metadata: { foo: 'bar' } }
    setMdata['set_' + mdataKey] = mdata;
    return setMdata;
};



/*
 * Creates a remove_metadata object
 */
exports.deleteMetadata = function(mdataKey, key) {
    var setMdata = {};
    setMdata['remove_' + mdataKey] = [key];
    return setMdata;
};



/*
 * Gets all metadata keys from a machine
 */
exports.deleteAllMetadata = function(machine, mdataKey) {
    var setMdata = {};
    var keys = [];

    Object.keys(machine[mdataKey]).forEach(function (key) {
        keys.push(key);
    });

    setMdata['remove_' + mdataKey] = keys;
    return setMdata;
};
