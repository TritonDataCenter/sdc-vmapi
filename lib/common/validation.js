/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var assert = require('assert');
var restify = require('restify');

var common = require('./vm-common');


var UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/*JSSTYLED*/
var ALIAS_RE = /^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9\-]*[A-Za-z0-9])$/;
/*JSSTYLED*/
var IP_RE = /^(([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/;

var VALID_VM_BRANDS = [
    'joyent-minimal',
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
 * Validates if an array contains UUIDs
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
        if (!UUID_RE.test(uuid)) {
            return false;
        }
    }

    return true;
}

exports.validUUIDs = validUUIDs;



/*
 * Validates if a comma separated string contains UUIDs
 */
function validNetworks(object) {
    var array;
    var obj;
    var uuid;

    if (Array.isArray(object)) {
        array = object;
    } else if (typeof (object) === 'string') {
        array = object.split(',');
    } else {
        return false;
    }

    for (var i = 0; i < array.length; i++) {
        obj = array[i];

        // Legacy: [ uuid1, uuid2, uuid3 ]
        // New: [ { uuid: uuid1 }, { uuid: uuid2, ip: ip2 }, { uuid: uuid2 } ]
        if (typeof (obj) == 'string') {
            uuid = obj;
        } else {
            uuid = obj.uuid;
        }

        if (!uuid || !UUID_RE.test(uuid)) {
            return false;
        }
    }

    return true;
}

exports.validNetworks = validNetworks;



/*
 * Validates if an alias is url compatible
 */
function validAlias(alias) {
    return ALIAS_RE.test(alias);
}

exports.validAlias = validAlias;



/*
 * Validates if a vm brand is either joyent or kvm
 */
function validBrand(brand) {
    return VALID_VM_BRANDS.indexOf(brand) != -1;
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
 * Validates if a vm is owned by the owner_uuid in the params
 */
function validOwner(vm, params) {
    var owner_uuid = params.owner_uuid;

    if (owner_uuid) {
        if (!validUUID(owner_uuid)) {
            throw new restify.InvalidArgumentError('\'owner_uuid\' is not a ' +
                                                   'valid UUID');
        }

        if (owner_uuid != vm.owner_uuid) {
             throw new restify.ResourceNotFoundError('VM not found');
        }
    }

    return true;
}

exports.validOwner = validOwner;



/*
 * Validates if a metadata object contains only strings, numbers or booleans
 */
function validMetadata(name, obj) {
    var types = ['string', 'boolean', 'number'];

    for (var key in obj) {
        if (types.indexOf(typeof (obj[key])) == -1) {
            throw new restify.InvalidArgumentError('\'' + name + '\' is not ' +
            'a valid metadata object');
        }
    }

    return true;
}

exports.validMetadata = validMetadata;



/*
 * Validates and creates metadata object to be used for vmadm update
 *
 * - vm: VM to update
 * - mdataKey: any of customer_metadata, internal_metadata or tags
 * - params: params to be sent to WFAPI
 * - obj: input object from the request
 */
function createMetadataObject(vm, mdataKey, params, obj) {
    var metadata;

    if (typeof (obj) === 'object') {
        metadata = obj;

    } else if (typeof (obj) === 'string') {
        try {
            metadata = JSON.parse(obj);
        } catch (e) {
        		throw new restify.InvalidArgumentError('\'%s\' is' +
                        'not valid \'' + mdataKey + '\'', obj);
        }
    } else {
        throw new restify.InvalidArgumentError('\'' + mdataKey + '\' ' +
                                    obj + ' is invalid');
    }


    validMetadata(mdataKey, metadata);
    var updateObject = common.setMetadata(vm, mdataKey, metadata);

    if (updateObject['set_' + mdataKey]) {
        params['set_' + mdataKey] = updateObject['set_' + mdataKey];
    }

    if (updateObject['remove_' + mdataKey]) {
        params['remove_' + mdataKey] = updateObject['remove_' + mdataKey];
    }

    return true;
}


/*
 * Validates a vm representation given a set of request parameters
 */
exports.validateVm = function (ufds, params, callback) {
    return validateParams(ufds, params, callback);
};



/*
 * Validates a vm representation given a set of request parameters
 */
function validateParams(ufds, params, callback) {
    // uuid
    if (params.uuid && !validUUID(params.uuid)) {
        return callback(
                new restify.InvalidArgumentError('\'uuid\' is not a ' +
                                                 'valid UUID'));
    }

    // owner_uuid
    if (!params.owner_uuid) {
        return callback(
            new restify.MissingParameterError('\'owner_uuid\' is required'));
    }

    if (!validUUID(params.owner_uuid)) {
        return callback(
                new restify.InvalidArgumentError('\'owner_uuid\' is not a ' +
                                                 'valid UUID'));
    }

    // server_uuid
    if (params.server_uuid && !validUUID(params.server_uuid)) {
        return callback(
                new restify.InvalidArgumentError('\'server_uuid\' is not a ' +
                                                 'valid UUID'));
    }

    // image_uuid
    if (!params.image_uuid && !params.dataset_uuid) {
         return callback(
            new restify.MissingParameterError('\'image_uuid\' is required'));
    }

    // DEPRECATED
    if (params.dataset_uuid && !validUUID(params.dataset_uuid)) {
        return callback(
            new restify.InvalidArgumentError('\'dataset_uuid\' is not ' +
                                             'a valid UUID'));
    }

    if (params.image_uuid && !validUUID(params.image_uuid)) {
        return callback(
            new restify.InvalidArgumentError('\'image_uuid\' is not ' +
                                             'a valid UUID'));
    }

    // brand
    if (!params.brand) {
        return callback(
            new restify.MissingParameterError('VM \'brand\' is required'));
    }

    if (!validBrand(params.brand)) {
        return callback(new restify.InvalidArgumentError('%s is not a valid ' +
                                               'vm \'brand\'', params.brand));
    }

    // ram
    if (!params.ram) {
        return callback(
            new restify.MissingParameterError('VM \'ram\' is required'));
    }

    if (!validNumber(params.ram)) {
        return callback(new restify.InvalidArgumentError('%s is not a valid ' +
                                            'number for \'ram\'', params.ram));
    }

    // cpu_shares
    if (params.cpu_shares && !validNumber(params.cpu_shares)) {
        return callback(new restify.InvalidArgumentError('%s is not a valid ' +
                                    'number for \'cpu_shares\'', params.ram));
    }

    // networks
    if (params.networks) {
        if (!validNetworks(params.networks)) {
            return callback(
                    new restify.InvalidArgumentError('\'%s\' are not valid ' +
                        '\'networks\'', params.networks));
        }
    } else {
        return callback(
            new restify.MissingParameterError('\'networks\' are required'));
    }

    // customer_metadata
    if (params.customer_metadata &&
        (typeof (params.customer_metadata) === 'string')) {
        try {
            params.customer_metadata = JSON.parse(params.customer_metadata);
            validMetadata('customer_metadata', params.customer_metadata);
        } catch (e) {
            return callback(
                    new restify.InvalidArgumentError('\'%s\' is not valid ' +
                        '\'customer_metadata\'', params.customer_metadata));
        }
    }

    // internal_metadata
    if (params.internal_metadata &&
        (typeof (params.internal_metadata) === 'string')) {
        try {
            params.internal_metadata = JSON.parse(params.internal_metadata);
            validMetadata('internal_metadata', params.internal_metadata);
        } catch (e) {
            return callback(
                    new restify.InvalidArgumentError('\'%s\' is not valid ' +
                        '\'internal_metadata\'', params.internal_metadata));
        }
    }

    // tags
    if (params.tags && (typeof (params.tags) === 'string')) {
        try {
            params.tags = JSON.parse(params.tags);
            validMetadata('tags', params.tags);
        } catch (e) {
            return callback(
                    new restify.InvalidArgumentError('\'%s\' are not valid ' +
                        '\'tags\'', params.tags));
        }
    }

    // alias
    if (params.alias && !validAlias(params.alias)) {
        return callback(new restify.InvalidArgumentError('\'alias\' ' +
                                                params.alias + ' is invalid'));
    }

    if (params.alias) {
        return validateUniqueAlias(ufds, params, callback);
    } else {
        return callback(null);
    }
}



/*
 * Validates that the vm alias is unique per customer
 */
function validateUniqueAlias(ufds, params, callback) {
    var query = {
        owner_uuid: params.owner_uuid,
        alias: params.alias,
        state: 'active'
    };

    ufds.listVms(query, function (err, vms) {
        if (err) {
            return callback(err);
        }

        if (vms.length > 0) {
            return callback(new restify.InvalidArgumentError('\'alias\' ' +
                                        params.alias + ' is already taken'));
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
exports.validateUpdate = function (vm, obj) {
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
                throw new restify.InvalidArgumentError('VM \'' +
                prop + '\' is invalid');
            }
        }
    });

    if (obj.owner_uuid) {
        if (typeof (obj.owner_uuid) === 'string' && validUUID(obj.owner_uuid)) {
            params.owner_uuid = obj.owner_uuid;
        } else {
            throw new restify.InvalidArgumentError('\'owner_uuid\' ' +
                                            obj.owner_uuid + ' is invalid');
        }
    }

    if (obj.alias) {
        if (typeof (obj.alias) === 'string' && validAlias(obj.alias)) {
            params.alias = obj.alias;
        } else {
            throw new restify.InvalidArgumentError('\'alias\' ' + obj.alias +
                                            ' is invalid');
        }
    }

    if (obj['customer_metadata']) {
        createMetadataObject(vm,
            'customer_metadata',
            params,
            obj['customer_metadata']);
    }

    if (obj['internal_metadata']) {
        createMetadataObject(vm,
            'internal_metadata',
            params,
            obj['internal_metadata']);
    }

    if (obj.tags) {
        createMetadataObject(vm,
            'tags',
            params,
            obj['tags']);
    }

    if (Object.keys(params).length == 0)
        throw new restify.MissingParameterError('You have not provided any ' +
                'parameters for vm update');

    return params;
};



/*
 * Sets default attributes for a vm on things that depend on
 * RAM or disk for example
 */
exports.setDefaultValues = function (params) {
    assert.ok(params.ram);
    params.ram = parseInt(params.ram);

    if (!params.max_physical_memory) {
        params.max_physical_memory = params.ram;
    }

    if (!params.max_swap) {
        params.max_swap = params.ram * 2;
    }

    if (!params.cpu_shares) {
        if (params.ram > 128)
            params.cpu_shares = Math.floor(params.ram / 128);
        else
            params.cpu_shares = 1;
    }

    if (params.networks && typeof (params.networks) === 'string') {
        params.networks = params.networks.split(',');
    }

    if (!params.image_uuid) {
        params.image_uuid = params.dataset_uuid;
    }
};
