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

exports.validUUID = validUUID;


/*
 * Validates if a comma separated string contains UUIDs
 */
function validUUIDs(object) {
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

exports.validUUIDs = validUUIDs;



/*
 * Validates if an alias is url compatible
 */
function validAlias(alias) {
    return ALIAS_RE.test(alias);
}

exports.validAlias = validAlias;



/*
 * Validates if a machine brand is either joyent or kvm
 */
function validBrand(brand) {
    return VALID_MACHINE_BRANDS.indexOf(brand) != -1;
}

exports.validBrand = validBrand;



/*
 * Validates if a param is a valid number
 */
function validNumber(param) {
    var number = parseInt(param);
    return (number > 0 ? true : false);
}

exports.validNumber = validNumber;



/*
 * Validates if a machine is owned by the owner_uuid in the params
 */
function validOwner(machine, params) {
    var owner_uuid = params.owner_uuid;

    if (owner_uuid) {
        if (!validUUID(owner_uuid)) {
            throw new restify.ConflictError('Owner UUID is not a valid UUID');
        }

        if (owner_uuid != machine.owner_uuid) {
             throw new restify.ResourceNotFoundError('Machine not found');
        }
    }

    return true;
}

exports.validOwner = validOwner;



/*
 * Validates a machine representation given a set of request parameters
 */
exports.validateMachine = function(ufds, params, callback) {
    return validateParams(ufds, params, callback);
}



/*
 * Validates a machine representation given a set of request parameters
 */
function validateParams(ufds, params, callback) {
    if (!params.owner_uuid) {
        return callback(
                new restify.MissingParameterError('Owner UUID is required'));
    }

    if (!validUUID(params.owner_uuid)) {
        return callback(
                new restify.ConflictError('Owner UUID is not a valid UUID'));
    }

    if (!params.dataset_uuid) {
        return callback(
                new restify.MissingParameterError('Dataset UUID is required'));
    }

    if (!validUUID(params.dataset_uuid)) {
        return callback(
                new restify.ConflictError('Dataset UUID is not a valid UUID'));
    }

    if (!params.brand) {
        return callback(
            new restify.MissingParameterError('Machine brand is required'));
    }

    if (!validBrand(params.brand)) {
        return callback(new restify.InvalidArgumentError('%s is not a valid ' +
                                               'machine brand', params.brand));
    }

    if (!params.ram) {
        return callback(
            new restify.MissingParameterError('Machine RAM is required'));
    }

    if (!validNumber(params.ram)) {
        return callback(new restify.InvalidArgumentError('%s is not a valid ' +
                                               'number for RAM', params.ram));
    }

    if (params.cpu_shares && !validNumber(params.cpu_shares)) {
        return callback(new restify.InvalidArgumentError('%s is not a valid ' +
                                        'number for CPU shares', params.ram));
    }

    if (!params.networks) {
        return callback(
            new restify.MissingParameterError('Networks are required'));
    }

    if (!validUUIDs(params.networks)) {
        return callback(
                new restify.InvalidArgumentError('\'%s\' are not valid ' +
                    'UUIDs for Networks', params.networks));
    }

    if (params.customer_metadata &&
        (typeof(params.customer_metadata) === 'string')) {
        try {
            params.customer_metadata = JSON.parse(params.customer_metadata);
        } catch (e) {
            return callback(
                    new restify.InvalidArgumentError('\'%s\' is not valid ' +
                        'customer metadata', params.customer_metadata));
        }
    }

    if (params.internal_metadata &&
        (typeof(params.internal_metadata) === 'string')) {
        try {
            params.internal_metadata = JSON.parse(params.internal_metadata);
        } catch (e) {
            return callback(
                    new restify.InvalidArgumentError('\'%s\' is not valid ' +
                        'internal metadata', params.internal_metadata));
        }
    }

    if (params.tags && (typeof(params.tags) === 'string')) {
        try {
            params.tags = JSON.parse(params.tags);
        } catch (e) {
            return callback(
                    new restify.InvalidArgumentError('\'%s\' are not valid ' +
                        'tags', params.tags));
        }
    }

    if (params.alias && !validAlias(params.alias)) {
        return callback(new restify.ConflictError('Alias ' + params.alias +
                                           ' is invalid'));
    }

    if (params.alias) {
        return validateUniqueAlias(ufds, params, callback);
    } else {
        return callback(null);
    }
}



/*
 * Validates that the machine alias is unique per customer
 */
function validateUniqueAlias(ufds, params, callback) {
    var query = {
        owner_uuid: params.owner_uuid,
        alias: params.alias
    };

    ufds.listMachines(query, function (err, machines) {
        if (err)
            return callback(err);

        if (machines.length > 0) {
            return callback(new restify.ConflictError('Alias ' + params.alias +
                                                    ' is already taken'));
        } else {
            return callback(null);
        }
    });
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
            throw new restify.ConflictError('Alias ' + obj.alias +
                                            ' is invalid');
        }
    }

    if (obj.customer_metadata) {
        if (typeof(obj.customer_metadata) === 'object') {
            params['set_customer_metadata'] = obj.customer_metadata;
        } else if (typeof(obj.customer_metadata) === 'string') {
            try {
                params['set_customer_metadata'] =
                    JSON.parse(obj.customer_metadata);
            } catch (e) {
                return callback(
                    new restify.InvalidArgumentError('\'%s\' is not valid ' +
                            'customer metadata', obj.customer_metadata));
            }
        } else {
            throw new restify.ConflictError('Customer metadata ' +
                                        obj.customer_metadata + ' is invalid');
        }
    }

    if (obj.internal_metadata) {
        if (typeof(obj.internal_metadata) === 'object') {
            params['set_internal_metadata'] = obj.internal_metadata;
        } else if (typeof(obj.internal_metadata) === 'string') {
            try {
                params['set_internal_metadata'] =
                    JSON.parse(obj.internal_metadata);
            } catch (e) {
                return callback(
                    new restify.InvalidArgumentError('\'%s\' is not valid ' +
                            'internal metadata', obj.internal_metadata));
            }
        } else {
            throw new restify.ConflictError('Internal metadata ' +
                                        obj.internal_metadata + ' is invalid');
        }
    }

    if (obj.tags) {
        if (typeof(obj.tags) === 'object') {
            params['set_tags'] = obj.tags;
        } else if (typeof(obj.tags) === 'string') {
            try {
                params['set_tags'] = JSON.parse(obj.tags);
            } catch (e) {
                return callback(
                    new restify.InvalidArgumentError('\'%s\' are not valid ' +
                            'tags', obj.tags));
            }
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
