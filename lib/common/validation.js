/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var assert = require('assert');
var restify = require('restify');

var errors = require('../errors');
var common = require('./vm-common');


var UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/*JSSTYLED*/
var ALIAS_RE = /^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9\-]*[A-Za-z0-9])$/;
/*JSSTYLED*/
var IP_RE = /^(([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/;

var VALID_VM_BRANDS = [
    'joyent-minimal',
    'joyent',
    'kvm',
    'sngl'
];

var DEFAULT_QUOTA = 10240;


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
            var error = [ errors.invalidUuidErr('owner_uuid') ];
            throw new errors.ValidationFailedError('Invalid Parameters', error);
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
            var error = [ errors.invalidParamErr(name + '.' + key) ];
            throw new errors.ValidationFailedError(
                'Invalid Metadata Parameters', error);
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
    var error;

    if (typeof (obj) === 'object') {
        metadata = obj;

    } else if (typeof (obj) === 'string') {
        try {
            metadata = JSON.parse(obj);
        } catch (e) {
            error = [ errors.invalidParamErr(mdataKey, 'Malformed JSON') ];
            throw new errors.ValidationFailedError('Invalid Parameters', error);
        }
    } else {
        error = [ errors.invalidParamErr(mdataKey, 'Invalid data type') ];
        throw new errors.ValidationFailedError('Invalid Parameters', error);
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
exports.validateVm = function (moray, params, callback) {
    return validateParams(moray, params, callback);
};



/*
 * Validates a vm representation given a set of request parameters
 */
function validateParams(moray, params, callback) {
    var message;
    var errs = [];

    // uuid
    if (params.uuid && !validUUID(params.uuid)) {
        errs.push(errors.invalidUuidErr);
    }

    // owner_uuid
    if (!params.owner_uuid) {
        errs.push(errors.missingParamErr('owner_uuid'));
    } else if (!validUUID(params.owner_uuid)) {
        errs.push(errors.invalidUuidErr('owner_uuid'));
    }

    // server_uuid
    if (params.server_uuid && !validUUID(params.server_uuid)) {
        errs.push(errors.invalidUuidErr('server_uuid'));
    }

    // image_uuid
    if (!params.image_uuid && !params.dataset_uuid) {
        errs.push(errors.missingParamErr('image_uuid'));
    }

    // billing_id
    if (params.billing_id && !validUUID(params.billing_id)) {
        errs.push(errors.invalidUuidErr('billing_id'));
    }

    // DEPRECATED
    if (params.dataset_uuid && !validUUID(params.dataset_uuid)) {
        errs.push(errors.invalidUuidErr('dataset_uuid'));
    }

    if (params.image_uuid && !validUUID(params.image_uuid)) {
        errs.push(errors.invalidUuidErr('image_uuid'));
    }

    // brand
    if (!params.brand) {
        errs.push(errors.missingParamErr('brand'));
    } else if (!validBrand(params.brand)) {
        message = 'Must be one of: ' + VALID_VM_BRANDS.join(', ');
        errs.push(errors.invalidParamErr('brand', message));
    }

    // ram
    if (!params.ram) {
        errs.push(errors.missingParamErr('ram'));
    } else if (!validNumber(params.ram)) {
        errs.push(errors.invalidParamErr('ram', 'Not a valid number'));
    }

    // cpu_shares
    if (params.cpu_shares && !validNumber(params.cpu_shares)) {
        errs.push(errors.invalidParamErr('ram', 'Not a valid number'));
    }

    // networks
    if (params.networks) {
        if (!validNetworks(params.networks)) {
            errs.push(errors.invalidParamErr('networks',
                'Invalid networks array'));
        }
    } else {
        errs.push(errors.missingParamErr('networks'));
    }

    // customer_metadata
    if (params.customer_metadata &&
        (typeof (params.customer_metadata) === 'string')) {
        try {
            params.customer_metadata = JSON.parse(params.customer_metadata);
            validMetadata('customer_metadata', params.customer_metadata);
        } catch (e) {
            errs.push(errors.invalidParamErr('customer_metadata'));
        }
    }

    // internal_metadata
    if (params.internal_metadata &&
        (typeof (params.internal_metadata) === 'string')) {
        try {
            params.internal_metadata = JSON.parse(params.internal_metadata);
            validMetadata('internal_metadata', params.internal_metadata);
        } catch (e) {
            errs.push(errors.invalidParamErr('internal_metadata'));
        }
    }

    // tags
    if (params.tags && (typeof (params.tags) === 'string')) {
        try {
            params.tags = JSON.parse(params.tags);
            validMetadata('tags', params.tags);
        } catch (e) {
            errs.push(errors.invalidParamErr('tags'));
        }
    }

    // alias
    if (params.alias && !validAlias(params.alias)) {
        errs.push(errors.invalidParamErr('alias'));
    }

    if (errs.length) {
        return callback(
            new errors.ValidationFailedError('Invalid VM parameters', errs));
    }

    if (params.alias) {
        return validateUniqueAlias(moray, params, callback);
    } else {
        return callback(null);
    }
}



/*
 * Validates that the vm alias is unique per customer
 */
function validateUniqueAlias(moray, params, callback) {
    var query = {
        owner_uuid: params['owner_uuid'],
        alias: params.alias,
        state: 'active'
    };

    moray.listVms(query, function (err, vms) {
        if (err) {
            return callback(err);
        }

        if (vms.length > 0) {
            var message = 'Already exists for this owner_uuid';
            var errs = [ errors.duplicateParamErr('alias', message) ];
            /*JSSTYLED*/
            return callback(new errors.ValidationFailedError('Invalid VM parameters', errs));
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
 * - firewall_enabled
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
    var errs = [];
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
                errs.push(errors.invalidParamErr(prop, 'Not a valid number'));
            }
        }
    });

    if (obj['new_owner_uuid']) {
        /*JSSTYLED*/
        if (typeof (obj['new_owner_uuid']) === 'string' && validUUID(obj['new_owner_uuid'])) {
            params['new_owner_uuid'] = obj['new_owner_uuid'];
        } else {
            errs.push(errors.invalidUuidErr('new_owner_uuid'));
        }
    }

    if (obj.alias) {
        if (typeof (obj.alias) === 'string' && validAlias(obj.alias)) {
            params.alias = obj.alias;
        } else {
            errs.push(errors.invalidParamErr('alias'));
        }
    }

    if (obj.autoboot !== undefined) {
        if (typeof (obj.autoboot) === 'boolean') {
            params.autoboot = obj.autoboot;
        } else {
            errs.push(errors.invalidParamErr('autoboot'));
        }
    }

    if (obj['customer_metadata']) {
        try {
            createMetadataObject(vm,
                'customer_metadata',
                params,
                obj['customer_metadata']);
        } catch (e) {
            errs.push(errors.invalidParamErr('customer_metadata'));
        }
    }

    if (obj.firewall_enabled !== undefined) {
        if (typeof (obj.firewall_enabled) === 'boolean') {
            params.firewall_enabled = obj.firewall_enabled;
        } else {
            errs.push(errors.invalidParamErr('firewall_enabled'));
        }
    }

    if (obj['internal_metadata']) {
        try {
            createMetadataObject(vm,
                'internal_metadata',
                params,
                obj['internal_metadata']);
        } catch (e) {
            errs.push(errors.invalidParamErr('internal_metadata'));
        }
    }

    if (obj.tags) {
        try {
            createMetadataObject(vm,
                'tags',
                params,
                obj['tags']);
        } catch (e) {
            errs.push(errors.invalidParamErr('tags'));
        }
    }

    if (obj['package_name']) {
        if (typeof (obj['package_name']) === 'string') {
            params['package_name'] = obj['package_name'];
        } else {
            errs.push(errors.invalidParamErr('package_name'));
        }
    }

    if (obj['package_version']) {
        if (typeof (obj['package_version']) === 'string') {
            params['package_version'] = obj['package_version'];
        } else {
            errs.push(errors.invalidParamErr('package_version'));
        }
    }

    if (obj['billing_id']) {
        if (typeof (obj['billing_id']) === 'string' &&
            validUUID(obj['billing_id'])) {
            params['billing_id'] = obj['billing_id'];
        } else {
            errs.push(errors.invalidUuidErr('billing_id'));
        }
    }

    if (errs.length) {
        throw new errors.ValidationFailedError('Invalid VM parameters', errs);
    }

    if (Object.keys(params).length === 0) {
        throw new errors.ValidationFailedError('No VM parameters provided', []);
    }

    return params;
};



/*
 * Sets default attributes for a vm on things that depend on
 * RAM or disk for example
 */
exports.setDefaultValues = function (params) {
    assert.ok(params.ram);
    params.ram = parseInt(params.ram, 10);

    if (!params.max_physical_memory) {
        params.max_physical_memory = params.ram;
    }

    if (!params.max_swap) {
        params.max_swap = params.ram * 2;
    }

    if (!params.quota) {
        params.quota = DEFAULT_QUOTA;
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
