/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var assert = require('assert');
var restify = require('restify');
var format = require('util').format;

var errors = require('../errors');
var common = require('./vm-common');


var UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/*JSSTYLED*/
var ALIAS_RE = /^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9\-]*[A-Za-z0-9])$/;
/*JSSTYLED*/
var IP_RE = /^(([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/;
var PW_SUFFIX = /^(.*)_pw$/;

var VALID_VM_BRANDS = [
    'joyent-minimal',
    'joyent',
    'kvm',
    'sngl'
];

var DEFAULT_QUOTA = 10; // GiB
var MIN_SWAP = 256;     // MiB


/*
 * Validates if a string is a UUID
 */
function validUUID(uuid) {
    return UUID_RE.test(uuid);
}

exports.validUUID = validUUID;



/*
 * Validates if an array contains strings
 */
function validStrings(object) {
    var array;
    var string;

    if (Array.isArray(object)) {
        array = object;
    } else if (typeof (object) === 'string') {
        array = object.split(',');
    } else {
        return false;
    }

    for (var i = 0; i < array.length; i++) {
        string = array[i];
        if (typeof (string) !== 'string') {
            return false;
        }
    }

    return true;
}

exports.validStrings = validStrings;



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
 * If isProvision is true then it will assume a new VM that has no NICs yet,
 * therefore marking the first NIC as primary if not explicitly done for others.
 * If isProvision is false it means that we can't deafult a NIC as primary
 */
function validNetworks(object, isProvision) {
    var networks = [];
    var primaries = 0;
    var array, obj, uuid;

    if (Array.isArray(object)) {
        array = object;
    } else if (typeof (object) === 'string') {
        array = object.split(',');
    } else {
        throw new Error('Malformed networks object');
    }

    for (var i = 0; i < array.length; i++) {
        obj = array[i];

        // Legacy: [ uuid1, uuid2 ]
        // New: [ { uuid: uuid1, primary: true }, { uuid: uuid2, ip: ip2 } ]
        if (typeof (obj) == 'string') {
            uuid = obj;
            obj = { uuid: uuid };
        } else if (obj.primary !== undefined) {
            primaries++;
        }

        if (obj.uuid && !UUID_RE.test(obj.uuid)) {
            throw new Error(format('Invalid uuid %s', obj.uuid));
        } else if (!obj.uuid && !obj.name) {
            throw new Error('Network object must specify a UUID or a name');
        }
        networks.push(obj);
    }

    // Two primaries were specified
    if (primaries > 1) {
        throw new Error('Cannot specify more than one primary network');
    } else if (isProvision === true && primaries === 0) {
        networks[0].primary = true;
    } // else just one primary which is fine

    return networks;
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
 * Validates if a param is a valid number. If gezero (greater or equal than
 * zero) is true, then >= will be used instead of >
 */
function validNumber(param, gezero) {
    var number = parseInt(param, 10);
    if (gezero === true) {
        return (number >= 0 ? true : false);
    } else {
        return (number > 0 ? true : false);
    }
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
    var error;

    for (var key in obj) {
        if (types.indexOf(typeof (obj[key])) == -1) {
            error = [ errors.invalidParamErr(name + '.' + key,
                'Forbidden Data Type') ];
            throw new errors.ValidationFailedError(
                'Invalid Parameter', error);
        } else if (name === 'customer_metadata' && PW_SUFFIX.test(key)) {
            error = [ errors.invalidParamErr(name + '.' + key,
                'Forbidden Metadata Key') ];
            throw new errors.ValidationFailedError(
                'Invalid Parameter', error);
        }
    }

    return true;
}

exports.validMetadata = validMetadata;



/*
 * Validates that the disks for the KVM VM have a valid format
 */
function validDisks(disks, errs) {
    var i;
    var ndisks = disks.length;
    var disk0 = disks[0];

    if (disk0['image_uuid'] === undefined) {
        errs.push(errors.missingParamErr('disks.0.image_uuid'));
    } else if (!validUUID(disk0['image_uuid'])) {
        errs.push(errors.invalidUuidErr('disks.0.image_uuid'));
    }

    if (disk0.size !== undefined) {
        errs.push(errors.invalidParamErr('disks.0.size', 'Not Allowed'));
    }


    for (i = 1; i < ndisks; i++) {
        var disk = disks[i];

        if (disk['image_uuid'] !== undefined) {
            errs.push(errors.invalidParamErr('disks.' + i + '.image_uuid',
                'Not Allowed'));
        }

        if (disk.size === undefined) {
            errs.push(errors.missingParamErr('disks.' + i + '.size'));
        }
    }

    return true;
}



/*
 * Does additional validation depending on the VM brand. This function only
 * populates the errors array that was passed in case some fields are not valid,
 * and later on the main validation code will throw an exception if needed
 */
function validateBrandParams(params, errs) {
    if (params.brand === 'kvm') {
        // image_uuid is not allowed at top level
        if (params['image_uuid'] !== undefined) {
            errs.push(errors.invalidParamErr('image_uuid',
                '\'image_uuid\' is not allowed as a top level attribute for' +
                ' a KVM VM'));
        }

        // disks
        if (!params.disks) {
            errs.push(errors.missingParamErr('disks'));
            return;
        } else if (typeof (params.disks) === 'string') {
            try {
                params.disks = JSON.parse(params.disks);
            } catch (e) {
                errs.push(errors.invalidParamErr('disks', 'Malformed JSON'));
                return;
            }
        }

        if (!Array.isArray(params.disks) || (params.disks.length < 1)) {
            errs.push(errors.invalidParamErr('disks'));
        } else {
            validDisks(params.disks, errs);
        }

    } else {
        // Only non-kvm vms require image_uuid
        if (params['image_uuid'] === undefined) {
            errs.push(errors.missingParamErr('image_uuid'));
        } else if (!validUUID(params['image_uuid'])) {
            errs.push(errors.invalidUuidErr('image_uuid'));
        }
    }
}



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
        errs.push(errors.invalidUuidErr('uuid'));
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

    // billing_id
    if (params.billing_id && !validUUID(params.billing_id)) {
        errs.push(errors.invalidUuidErr('billing_id'));
    }

    // brand
    if (!params.brand) {
        errs.push(errors.missingParamErr('brand'));
    } else if (!validBrand(params.brand)) {
        message = 'Must be one of: ' + VALID_VM_BRANDS.join(', ');
        errs.push(errors.invalidParamErr('brand', message));
    }

    // when no package is passed, we want to validate presence of ram and
    // max_physical_memory at least
    if (!params.billing_id) {
        if (params.brand === 'kvm' && !params.ram) {
            errs.push(errors.missingParamErr('ram', 'Is required for KVM'));
        } else if (!params.max_physical_memory && !params.ram) {
            errs.push(errors.missingParamErr('ram'));
        }
    }

    if (params.ram && !validNumber(params.ram)) {
        errs.push(errors.invalidParamErr('ram', 'Not a valid number'));
    }

    if (params.max_physical_memory &&
        !validNumber(params.max_physical_memory)) {
        errs.push(errors.invalidParamErr('max_physical_memory',
            'Not a valid number'));
    }

    // networks
    if (params.networks) {
        try {
            params.networks = validNetworks(params.networks, true);
        } catch (e) {
            errs.push(errors.invalidParamErr('networks', e.message));
        }
    } else {
        errs.push(errors.missingParamErr('networks'));
    }

    // max_swap
    if (params.max_swap) {
        if (!validNumber(params.max_swap)) {
            errs.push(errors.invalidParamErr('max_swap', 'Not a valid number'));
        } else if (params.max_swap < MIN_SWAP) {
            errs.push(errors.invalidParamErr('max_swap',
                'Cannot be less than ' + MIN_SWAP));
        }
    }

    // cpu_shares
    if (params.cpu_shares && !validNumber(params.cpu_shares)) {
        errs.push(errors.invalidParamErr('cpu_shares', 'Not a valid number'));
    }

    // quota
    if (params.quota && !validNumber(params.quota, true)) {
        errs.push(errors.invalidParamErr('quota', 'Not a valid number'));
    }

    // tmpfs
    if (params.tmpfs && !validNumber(params.tmpfs, true)) {
        errs.push(errors.invalidParamErr('tmpfs', 'Not a valid number'));
    }

    // customer_metadata
    if (params.customer_metadata &&
        (typeof (params.customer_metadata) === 'string')) {
        try {
            params.customer_metadata = JSON.parse(params.customer_metadata);
            validMetadata('customer_metadata', params.customer_metadata);
        } catch (e) {
            if (e.body && e.body.errors) {
                errs.push(e.body.errors[0]);
            } else {
                errs.push(errors.invalidParamErr('customer_metadata'));
            }
        }
    }

    // internal_metadata
    if (params.internal_metadata &&
        (typeof (params.internal_metadata) === 'string')) {
        try {
            params.internal_metadata = JSON.parse(params.internal_metadata);
            validMetadata('internal_metadata', params.internal_metadata);
        } catch (e) {
            if (e.body && e.body.errors) {
                errs.push(e.body.errors[0]);
            } else {
                errs.push(errors.invalidParamErr('internal_metadata'));
            }
        }
    }

    // tags
    if (params.tags && (typeof (params.tags) === 'string')) {
        try {
            params.tags = JSON.parse(params.tags);
            validMetadata('tags', params.tags);
        } catch (e) {
            if (e.body && e.body.errors) {
                errs.push(e.body.errors[0]);
            } else {
                errs.push(errors.invalidParamErr('tags'));
            }
        }
    }

    // firewall_enabled
    if (params.hasOwnProperty('firewall_enabled') &&
        (typeof (params.firewall_enabled) !== 'boolean')) {
        errs.push(errors.invalidParamErr('firewall_enabled'));
    }

    // alias
    if (params.alias && !validAlias(params.alias)) {
        errs.push(errors.invalidParamErr('alias'));
    }

    validateBrandParams(params, errs);

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
        state: 'active',
        _update: true
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
 * - resolvers
 * - do_not_inventory
 * - fs_allowed
 */
exports.validateUpdate = function (moray, vm, obj, callback) {
    var errs = [];
    var params = {};
    var gezero;

    var properties = {
        max_physical_memory: 'Max. Physical Memory',
        ram: 'RAM',
        max_swap: 'Swap',
        quota: 'Quota',
        tmpfs: 'tmpfs',
        cpu_cap: 'CPU Cap',
        max_lwps: 'Max. Lightweight Processes',
        zfs_io_priority: 'ZFS IO  Priority'
    };

    Object.keys(properties).forEach(function (prop) {
        // Only allow >= 0 for quota or tmpfs
        gezero = ((prop === 'quota' || prop === 'tmpfs') ? true : false);

        if (obj[prop]) {
            if (validNumber(obj[prop], gezero)) {
                params[prop] = Number(obj[prop]);
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

    if (obj.alias !== undefined) {
        if (typeof (obj.alias) === 'string' &&
            (validAlias(obj.alias) || obj.alias === '')) {
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

    if (obj['limit_priv'] !== undefined) {
        if (typeof (obj['limit_priv']) === 'string') {
            params['limit_priv'] = obj['limit_priv'];
        } else {
            errs.push(errors.invalidParamErr('limit_priv'));
        }
    }

    if (obj['customer_metadata']) {
        try {
            createMetadataObject(vm,
                'customer_metadata',
                params,
                obj['customer_metadata']);
        } catch (e) {
            errs.push(e.body.errors[0]);
        }
    }

    if (obj.firewall_enabled !== undefined) {
        if (typeof (obj.firewall_enabled) === 'boolean') {
            params.firewall_enabled = obj.firewall_enabled;
        } else {
            errs.push(errors.invalidParamErr('firewall_enabled'));
        }
    }

    var dni = obj.do_not_inventory;
    if (dni !== undefined) {
        if ((typeof (dni) === 'boolean' && dni === true) ||
            (typeof (dni) === 'string' && dni === 'true')) {
            params.do_not_inventory = true;
        } else {
            errs.push(errors.invalidParamErr('do_not_inventory'));
        }
    }

    if (obj['internal_metadata']) {
        try {
            createMetadataObject(vm,
                'internal_metadata',
                params,
                obj['internal_metadata']);
        } catch (e) {
            errs.push(e.body.errors[0]);
        }
    }

    if (obj.tags) {
        try {
            createMetadataObject(vm,
                'tags',
                params,
                obj['tags']);
        } catch (e) {
            errs.push(e.body.errors[0]);
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

    if (obj.resolvers) {
        if (Array.isArray(obj.resolvers)) {
            params.resolvers = obj.resolvers;
        } else {
            errs.push(errors.invalidParamErr('resolvers', 'Not an array'));
        }
    }

    if (obj['update_disks']) {
        if (Array.isArray(obj['update_disks'])) {
            params['update_disks'] = obj['update_disks'];
        } else {
            errs.push(errors.invalidParamErr('update_disks', 'Not an array'));
        }
    }

    if (obj['fs_allowed']) {
        params['fs_allowed'] = obj['fs_allowed'];
    }

    if (errs.length) {
        return callback(
            new errors.ValidationFailedError('Invalid VM update parameters',
            errs));
    }

    if (Object.keys(params).length === 0) {
        return callback(
            new errors.ValidationFailedError('No VM parameters provided', []));
    }

    // Finally, validate that we are not changing to an alias in use
    if (params.alias !== undefined && params.alias !== '') {
        var vparams = { owner_uuid: vm.owner_uuid, alias: params.alias };
        validateUniqueAlias(moray, vparams, function (err) {
            if (err) {
                return callback(err);
            }
            return callback(null, params);
        });
    } else {
        return callback(null, params);
    }
};



/*
 * Simple validator, just makes sure the networks parameter has the correct
 * format, it can be either a string (comma separated) or an array
 */
exports.validateNetworks = function (params) {
    var errs = [];

    if (params.networks) {
        try {
            params.networks = validNetworks(params.networks, false);
        } catch (e) {
            errs.push(errors.invalidParamErr('networks', e.message));
        }
    } else {
        errs.push(errors.missingParamErr('networks'));
    }

    if (errs.length) {
        throw new errors.ValidationFailedError('Invalid VM update parameters',
            errs);
    }

    return true;
};



/*
 * Simple validator, just makes sure the mac addresses parameter has the correct
 * format, it can be either a string (comma separated) or an array
 */
exports.validateMacs = function (params) {
    var errs = [];

    if (params.macs) {
        if (!validStrings(params.macs)) {
            errs.push(errors.invalidParamErr('macs',
                'Invalid MAC addresses object'));
        }
    } else {
        errs.push(errors.missingParamErr('macs'));
    }

    if (errs.length) {
        throw new errors.ValidationFailedError('Invalid VM update parameters',
            errs);
    }

    if (typeof (params.macs) === 'string') {
        params.macs = params.macs.split(',');
    }

    return true;
};



/*
 * Sets default attributes for a vm on things that depend on
 * RAM or disk for example
 */
exports.setDefaultValues = function (params) {
    var i;

    if (params.brand === 'kvm') {
        assert.ok(params.ram);
    }

    if (params.ram) {
        params.ram = parseInt(params.ram, 10);

        if (params.max_physical_memory === undefined) {
            params.max_physical_memory = params.ram;
        }
    }

    // Use these default values when a package was not specified
    if (params.billing_id === undefined) {
        if (params.max_swap === undefined) {
            var swap = params.ram * 2;
            if (swap < MIN_SWAP) swap = MIN_SWAP;
            params.max_swap = swap;
        }

        if (params.quota === undefined) {
            params.quota = DEFAULT_QUOTA;
        }

        if (params.cpu_shares === undefined) {
            if (params.ram > 128)
                params.cpu_shares = Math.floor(params.ram / 128);
            else
                params.cpu_shares = 1;
        }
    }

    if (params['post_back_urls'] &&
        typeof (params['post_back_urls']) === 'string') {
        params['post_back_urls'] = params['post_back_urls'].split(',');
    }

    if (params.firewall_enabled === undefined) {
        params.firewall_enabled = false;
    }

    if (params.brand === 'kvm') {
        // disk0 should not have a default value
        for (i = 1; i < params.disks.length; i++) {
            if (params.disks[i].refreservation === undefined) {
                params.disks[i].refreservation = 0;
            }
        }
    }

    var numKeys = [
        'ram',
        'cpu_burst_ratio',
        'cpu_cap',
        'cpu_shares',
        'max_lwps',
        'max_physical_memory',
        'max_swap',
        'overprovision_cpu',
        'overprovision_memory',
        'quota',
        'ram_ratio',
        'vcpus',
        'tmpfs',
        'zfs_io_priority'
    ];

    // Be a good API, convert '128' to 128
    for (i = 0; i < numKeys.length; i++) {
        if (params[numKeys[i]]) {
            params[numKeys[i]] = Number(params[numKeys[i]]);
        }
    }
};
