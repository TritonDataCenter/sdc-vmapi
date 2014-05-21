/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * All validation related functions. They mostly apply to CreateVm and UpdateVm
 */


var assert = require('assert');
var restify = require('restify');
var async = require('async');
var format = require('util').format;
var libuuid = require('libuuid');

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


var VM_FIELDS = [
    {
        name: 'alias',
        mutable: true
    },
    {
        name: 'autoboot',
        mutable: true
    },
    {
        name: 'billing_id',
        mutable: true
    },
    {
        name: 'brand',
        mutable: false
    },
    {
        name: 'cpu_cap',
        mutable: true
    },
    {
        name: 'cpu_shares',
        mutable: true
    },
    {
        name: 'cpu_type',
        mutable: false
    },
    {
        name: 'customer_metadata',
        mutable: false
    },
    {
        name: 'delegate_dataset',
        mutable: false
    },
    {
        name: 'disk_driver',
        mutable: false
    },
    {
        name: 'dns_domain',
        mutable: false
    },
    {
        name: 'do_not_inventory',
        mutable: true
    },
    {
        name: 'firewall_enabled',
        mutable: true
    },
    {
        name: 'fs_allowed',
        mutable: true
    },
    {
        name: 'hostname',
        mutable: false
    },
    {
        name: 'indestructible_delegated',
        mutable: true
    },
    {
        name: 'indestructible_zoneroot',
        mutable: true
    },
    {
        name: 'internal_metadata',
        mutable: false
    },
    {
        name: 'limit_priv',
        mutable: true
    },
    {
        name: 'maintain_resolvers',
        mutable: true
    },
    {
        name: 'max_locked_memory',
        mutable: true
    },
    {
        name: 'max_lwps',
        mutable: true
    },
    {
        name: 'max_physical_memory',
        mutable: true
    },
    {
        name: 'max_swap',
        mutable: true
    },
    {
        name: 'mdata_exec_timeout',
        mutable: false
    },
    {
        name: 'networks',
        mutable: false
    },
    {
        name: 'nic_driver',
        mutable: false
    },
    {
        name: 'overprovision_cpu',
        mutable: false
    },
    {
        name: 'overprovision_memory',
        mutable: false
    },
    {
        name: 'owner_uuid',
        mutable: false
    },
    {
        name: 'package_name',
        mutable: true
    },
    {
        name: 'package_version',
        mutable: true
    },
    {
        name: 'quota',
        mutable: true
    },
    {
        name: 'ram',
        mutable: true
    },
    {
        name: 'resolvers',
        mutable: true
    },
    {
        name: 'server_uuid',
        mutable: false
    },
    {
        name: 'tags',
        mutable: false
    },
    {
        name: 'tmpfs',
        mutable: true
    },
    {
        name: 'uuid',
        mutable: false
    },
    {
        name: 'vcpus',
        mutable: false
    },
    {
        name: 'zfs_data_compression',
        mutable: true
    },
    {
        name: 'zfs_io_priority',
        mutable: true
    }
];


var validators = {

    alias: function (params) {
        var errs = [];
        if (params.alias !== undefined && !ALIAS_RE.test(params.alias)) {
            errs.push(errors.invalidParamErr('alias'));
        }
        return errs;
    },

    autoboot: createValidateBooleanFn('autoboot'),

    billing_id: createValidateUUIDFn('billing_id', false),

    brand: function (params) {
        var errs = [];
        if (params.brand === undefined) {
            errs.push(errors.missingParamErr('brand'));
        } else if (!validBrand(params.brand)) {
            var message = 'Must be one of: ' + VALID_VM_BRANDS.join(', ');
            errs.push(errors.invalidParamErr('brand', message));
        }
        return errs;
    },

    cpu_cap: createValidateNumberFn('cpu_cap', true),

    cpu_shares: createValidateNumberFn('cpu_shares', true),

    cpu_type: createValidateStringFn('cpu_type'),

    customer_metadata: createValidateMetadataFn('customer_metadata'),

    delegate_dataset: createValidateBooleanFn('delegate_dataset'),

    disk_driver: createValidateStringFn('disk_driver'),

    dns_domain: createValidateStringFn('dns_domain'),

    do_not_inventory: createValidateBooleanFn('do_not_inventory'),

    firewall_enabled: createValidateBooleanFn('firewall_enabled'),

    fs_allowed: createValidateStringFn('fs_allowed'),

    hostname: createValidateStringFn('hostname'),

    indestructible_delegated:
        createValidateBooleanFn('indestructible_delegated'),

    indestructible_zoneroot: createValidateBooleanFn('indestructible_zoneroot'),

    internal_metadata: createValidateMetadataFn('internal_metadata'),

    limit_priv: createValidateStringFn('limit_priv'),

    maintain_resolvers: createValidateBooleanFn('maintain_resolvers'),

    max_locked_memory: createValidateNumberFn('max_locked_memory', true),

    max_lwps: createValidateNumberFn('max_lwps', true),

    max_physical_memory: createValidateNumberFn('max_physical_memory', true),

    max_swap: createValidateNumberFn('max_swap', true),

    mdata_exec_timeout: createValidateNumberFn('mdata_exec_timeout', false),

    networks: function (params) {
        var errs = [];

        if (params.networks) {
            try {
                params.networks = validNetworks(params.networks, true);
            } catch (e) {
                errs.push(errors.invalidParamErr('networks', e.message));
            }
        } else {
            errs.push(errors.missingParamErr('networks'));
        }

        return errs;
    },

    nic_driver: createValidateStringFn('nic_driver'),

    overprovision_cpu: createValidateNumberFn('overprovision_cpu', false),

    overprovision_memory: createValidateNumberFn('overprovision_memory', false),

    owner_uuid: createValidateUUIDFn('owner_uuid', true),

    package_name: createValidateStringFn('package_name'),

    package_version: createValidateStringFn('package_version'),

    quota: createValidateNumberFn('quota', true),

    ram: createValidateNumberFn('ram', false),

    resolvers: createValidateArrayFn('resolvers'),

    server_uuid: createValidateUUIDFn('server_uuid', false),

    tags: createValidateMetadataFn('tags'),

    tmpfs: createValidateNumberFn('tmpfs', true),

    uuid: createValidateUUIDFn('uuid', false),

    vcpus: createValidateNumberFn('vcpus', false),

    zfs_data_compression: createValidateStringFn('zfs_data_compression'),

    zfs_io_priority: createValidateNumberFn('zfs_io_priority', true)

};


/*
 * Returns a validateMetadata function
 */
function createValidateMetadataFn(field) {
    return function (params) {
        var errs = [];

        if (params[field] !== undefined) {
            try {
                if (typeof (params[field]) === 'string') {
                    params[field] = JSON.parse(params[field]);
                }
                validMetadata(field, params[field]);
            } catch (e) {
                if (e.body && e.body.errors) {
                    errs.push(e.body.errors[0]);
                } else {
                    errs.push(errors.invalidParamErr(field));
                }
            }
        }

        return errs;
    };
}


/*
 * Returns a validateArray function
 */
function createValidateArrayFn(field) {
    return function (params) {
        var errs = [];

        if (params[field] !== undefined && !Array.isArray(params[field])) {
            errs.push(errors.invalidParamErr(field, 'Not an array'));
        }

        return errs;
    };
}


/*
 * Returns a validateString function
 */
function createValidateStringFn(field) {
    return function (params) {
        var errs = [];

        if (params[field] !== undefined &&
            typeof (params[field]) !== 'string') {
            errs.push(errors.invalidParamErr(field, 'Not a valid string'));
        }

        return errs;
    };
}


/*
 * Returns a validateNumber function
 */
function createValidateNumberFn(field, gezero) {
    return function (params) {
        var errs = [];

        if (params[field] !== undefined) {
            if (validNumber(params[field], gezero)) {
                params[field] = Number(params[field]);
            } else {
                errs.push(errors.invalidParamErr(field, 'Not a valid number'));
            }
        }

        return errs;
    };
}


/*
 * Returns a validateBoolean function
 */
function createValidateBooleanFn(field) {
    return function (params) {
        var errs = [];

        if (params[field] !== undefined &&
            (typeof (params[field]) !== 'boolean')) {
            errs.push(errors.invalidParamErr(field));
        }

        return errs;
    };
}


/*
 * Returns a validateUUID function
 */
function createValidateUUIDFn(field, required) {
    if (required === undefined) required = false;

    return function (params) {
        var errs = [];

        if (params[field] === undefined && required) {
            errs.push(errors.missingParamErr(field));
        } else if (params[field] !== undefined && !validUUID(params[field])) {
            errs.push(errors.invalidUuidErr(field));
        }

        return errs;
    };
}


/*
 * Reused by Create/Update for checking package values and populating the
 * request params when some values are not present. This function should only
 * be called when a request contains billing_id
 */
function validatePackageValues(papi, params, callback) {
    var packageFields = ['cpu_cap', 'max_lwps', 'max_physical_memory',
        'max_swap', 'quota', 'vcpus', 'zfs_io_priority'];

    papi.getPackage(params.billing_id, function (err, pkg) {
        if (err) {
            return callback(err);
        }

        // Allow for manually overriding package params from original
        // provision params
        packageFields.forEach(function (field) {
            if (params[field] === undefined && pkg[field] !== undefined) {
                if (field === 'quota') {
                    if (params.brand === 'kvm') {
                        params.quota = 10;
                    } else {
                        params.quota = Number(pkg.quota) / 1024;
                    }
                } else {
                   params[field] = Number(pkg[field]);
                }
            }
        });

        // Special case for default values
        var pkgRam = pkg.max_physical_memory;
        if (pkgRam !== undefined) {
            if (params.max_physical_memory === undefined) {
                params.max_physical_memory = Number(pkgRam);
            } else if (params.ram === undefined) {
                params.ram = Number(pkgRam);
            }
        }
        pkgRam = params.max_physical_memory || params.ram;

        if (params.cpu_shares === undefined) {
            if (pkg.fss !== undefined) {
                params.cpu_shares = Math.floor(Number(pkg.fss));
                if (params.cpu_shares < 1) {
                    params.cpu_shares = 1;
                }
            } else {
                // Last resort default cpu_shares
                if (pkgRam > 128) {
                    params.cpu_shares = Math.floor(pkgRam / 128);
                } else {
                    params.cpu_shares = 1;
                }
            }
        }

        params['package'] = pkg;

        return callback();
    });
}


/*
 * Validates CreateVm parameters
 */
exports.validateCreateVmParams = function (vmapi, params, callback) {
    var errs = [];

    VM_FIELDS.forEach(function (field) {
        var fieldErrs = validators[field.name](params);
        errs = errs.concat(fieldErrs);
    });

    // when no package is passed, we want to validate presence of ram,
    // max_physical_memory and disks (when kvm) at least
    if (!params.billing_id) {
        if (params.brand === 'kvm' && !params.ram) {
            errs.push(errors.missingParamErr('ram', 'Is required for KVM'));
        } else if (!params.max_physical_memory && !params.ram) {
            errs.push(errors.missingParamErr('ram'));
        }
    }

    // max_swap
    if (params.max_swap !== undefined && params.max_swap < MIN_SWAP) {
        errs.push(errors.invalidParamErr('max_swap',
            'Cannot be less than ' + MIN_SWAP));
    }

    validateBrandParams(params, errs);

    // Async validations
    var asyncFns = [];
    if (params.uuid) {
        asyncFns.push(validateUniqueUuid);
    }
    if (params.alias) {
        asyncFns.push(validateAlias);
    }
    if (params.server_uuid) {
        asyncFns.push(validateServer);
    }
    if (params.billing_id &&
        params.billing_id !== '00000000-0000-0000-0000-000000000000') {
        asyncFns.push(validatePackage);
    }

    function validateUniqueUuid(next) {
        vmapi.moray.getVm({ uuid: params.uuid }, function onGetVm(err, vm) {
            if (err) {
                return next(err);
            }

            if (vm) {
                errs.push(errors.duplicateParamErr('uuid'));
            }
            return next();
        });
    }

    function validateAlias(next) {
        validateUniqueAlias(vmapi.moray, params, function (err, errorObj) {
            if (err) {
                return next(err);
            } else if (errorObj) {
                errs.push(errorObj);
            }
            return next();
        });
    }

    function validateServer(next) {
        vmapi.cnapi.getServer(params.server_uuid, function (err) {
            if (err) {
                if (err.name === 'ResourceNotFoundError') {
                    errs.push({
                        field: 'server_uuid',
                        code: 'Invalid',
                        message: err.message
                    });
                } else {
                    return next(err);
                }
            }
            return next();
        });
    }

    function validatePackage(next) {
        validatePackageValues(vmapi.papi, params, next);
    }

    async.series(asyncFns, function (err) {
        if (err) {
            return callback(err);
        }

        if (errs.length) {
            return callback(
                new errors.ValidationFailedError('Invalid VM parameters',
                    errs));
        }
        return callback(null);
    });
};



/*
 * Validates UpdateVm params
 */
exports.validateUpdateVmParams = function (vmapi, vm, obj, callback) {
    var errs = [];
    var params = {};

    VM_FIELDS.filter(function (field) {
        return field.mutable;
    }).forEach(function (field) {
        var fieldErrs = validators[field.name](obj);
        errs = errs.concat(fieldErrs);
        if (obj[field.name] !== undefined) {
            params[field.name] = obj[field.name];
        }
    });

    // special case for change_owner
    if (obj.new_owner_uuid) {
        if (typeof (obj.new_owner_uuid) === 'string' &&
            validUUID(obj.new_owner_uuid)) {
            params.new_owner_uuid = obj.new_owner_uuid;
        } else {
            errs.push(errors.invalidUuidErr('new_owner_uuid'));
        }
    }

    if (obj.customer_metadata) {
        try {
            createMetadataObject(vm,
                'customer_metadata',
                params,
                obj.customer_metadata);
        } catch (e) {
            errs.push(e.body.errors[0]);
        }
    }

    if (obj.internal_metadata) {
        try {
            createMetadataObject(vm,
                'internal_metadata',
                params,
                obj.internal_metadata);
        } catch (e) {
            errs.push(e.body.errors[0]);
        }
    }

    if (obj.tags) {
        try {
            createMetadataObject(vm,
                'tags',
                params,
                obj.tags);
        } catch (e) {
            errs.push(e.body.errors[0]);
        }
    }

    if (obj.update_disks) {
        if (Array.isArray(obj.update_disks)) {
            params.update_disks = obj.update_disks;
        } else {
            errs.push(errors.invalidParamErr('update_disks', 'Not an array'));
        }
    }

    // Async validations
    var asyncFns = [];
    if (params.alias) {
        asyncFns.push(validateAlias);
    }
    if (params.billing_id) {
        asyncFns.push(validatePackage);
    }

    function validateAlias(next) {
        var vparams = { owner_uuid: vm.owner_uuid, alias: params.alias };
        validateUniqueAlias(vmapi.moray, vparams, function (err, errorObj) {
            if (err) {
                return next(err);
            } else if (errorObj) {
                errs.push(errorObj);
            }
            return next();
        });
    }

    function validatePackage(next) {
        validatePackageValues(vmapi.papi, params, next);
    }

    async.series(asyncFns, function (err) {
        if (err) {
            return callback(err);
        }

        if (errs.length) {
            return callback(
                new errors.ValidationFailedError('Invalid VM update parameters',
                    errs));
        } else if (Object.keys(params).length === 0) {
            return callback(
                new errors.ValidationFailedError('No VM parameters provided',
                    []));
        }
        return callback(null, params);
    });
};



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


// Just make sure it works in case someone decides to send 'false'
function isPrimary(prm) {
    return (prm === undefined ? false : (prm === true || prm === 'true'));
}


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
        } else if (isPrimary(obj.primary)) {
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
 * Two validations at the moment:
 * - reordering: if you provide 'interface' for one nic, all others must have
 *      the same attribute as well
 * - reassigning primary: only one nic can be primary
 */
function validNics(vm, object) {
    var nics = [];
    var primaries = 0;
    var interfaces = 0;
    var array, obj;

    if (Array.isArray(object)) {
        array = object;
    } else if (typeof (object) === 'string') {
        array = object.split(',');
    } else {
        throw new Error('Malformed NICs object');
    }
    if (array.length === 0) {
        throw new Error('At least one NIC must be updated');
    }

    var nic;
    for (var i = 0; i < array.length; i++) {
        nic = {};
        obj = array[i];

        if (obj.mac === undefined) {
            throw new Error('All NICs must have a `mac` attribute');
        }
        nic.mac = obj.mac;

        if (isPrimary(obj.primary)) {
            nic.primary = obj.primary;
            primaries++;
        }
        if (obj['interface'] !== undefined) {
            nic['interface'] = obj['interface'];
            interfaces++;
        }

        var antiSpoofParams = ['allow_dhcp_spoofing', 'allow_ip_spoofing',
            'allow_mac_spoofing', 'allow_restricted_traffic'];
        antiSpoofParams.forEach(function (spoofParam) {
            if (obj.hasOwnProperty(spoofParam)) {
                nic[spoofParam] = obj[spoofParam];
            }
        });

        nics.push(nic);
    }

    // Two primaries were specified
    if (primaries > 1) {
        throw new Error('Cannot specify more than one primary NIC');
    } else if (interfaces > 0 && interfaces !== vm.nics.length) {
        throw new Error('If reordering, must specify a new `interface` ' +
            'for every NIC that the VM currently has');
    }

    return nics;
}

exports.validNics = validNics;



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

    if (disk0.image_uuid === undefined) {
        errs.push(errors.missingParamErr('disks.0.image_uuid'));
    } else if (!validUUID(disk0.image_uuid)) {
        errs.push(errors.invalidUuidErr('disks.0.image_uuid'));
    }

    if (disk0.size !== undefined) {
        errs.push(errors.invalidParamErr('disks.0.size', 'Not Allowed'));
    }


    for (i = 1; i < ndisks; i++) {
        var disk = disks[i];

        if (disk.image_uuid !== undefined) {
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
        // Skip disks validation if billing_id was passed. The disks will be
        // created from the package definition
        if (params.billing_id && !params.disks) {
            return;
        } else if (!params.disks) {
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
        if (params.image_uuid === undefined) {
            errs.push(errors.missingParamErr('image_uuid'));
        } else if (!validUUID(params.image_uuid)) {
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
 * Validates that the vm alias is unique per customer
 */
function validateUniqueAlias(moray, params, callback) {
    var query = {
        owner_uuid: params.owner_uuid,
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
            var error = errors.duplicateParamErr('alias', message);
            /*JSSTYLED*/
            return callback(null, error);
        } else {
            return callback(null);
        }
    });
}



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
 * This validator makes sure that each nic object in the array only contains
 * the following attributes:
 *
 * - mac: neeeded to identify the NIC
 * - interface: needed if want to reorder nics
 * - primary: needed if want to reassign primary
 */
exports.validateNics = function (vm, params) {
    var errs = [];

    if (params.nics) {
        try {
            params.nics = validNics(vm, params.nics);
        } catch (e) {
            errs.push(errors.invalidParamErr('nics', e.message));
        }
    } else {
        errs.push(errors.missingParamErr('nics'));
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

    if (params.uuid === undefined) {
        params.uuid = libuuid.create();
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

    if (params.post_back_urls &&
        typeof (params.post_back_urls) === 'string') {
        params.post_back_urls = params.post_back_urls.split(',');
    }

    if (params.firewall_enabled === undefined) {
        params.firewall_enabled = false;
    }

    if (params.brand === 'kvm' && params.disks && params.disks.length) {
        // disk0 should not have a default value
        for (i = 1; i < params.disks.length; i++) {
            if (params.disks[i].refreservation === undefined) {
                params.disks[i].refreservation = 0;
            }
        }
    }
};
