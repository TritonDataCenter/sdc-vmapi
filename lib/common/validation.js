/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * All validation related functions. They mostly apply to CreateVm and UpdateVm
 */


var assert = require('assert-plus');
var async = require('async');
var format = require('util').format;
var jsprim = require('jsprim');
var net = require('net');
var restify = require('restify');
var strsplit = require('strsplit');
var tritonTags = require('triton-tags');
var util = require('util');
var uuid = require('uuid');
var verror = require('verror');

var common = require('./vm-common');
var errors = require('../errors');
var markerUtils = require('./marker');
var predicateUtils = require('./predicate');
var sortValidation = require('../validation/sort');

var ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9\_\.\-]*$/;
var BRAND_NAME_DISALLOWED_CHARS_RE = /[^a-zA-Z\-]/;
var BRAND_NAME_MAX_LENGTH = 64; // should be enough for anyone
/* JSSTYLED */
var DOCKER_TAG_DEFAULT_RE = /^(?:sdc_docker$|docker:label:triton\.|docker:label:(?:com|io|org)\.docker(?:project)?\.)/;
var DOCKER_TAG_RE = DOCKER_TAG_DEFAULT_RE;
// For now, using the more limited labels allowed by RFC1123. RFC2181 supercedes
// 1123, but the broader range of characters can sometimes cause problems with
// other systems (e.g. see the underscore in RFC5321).
var DNS_NAME_RE = /^[a-z0-9][a-z0-9\-]{0,62}(?:\.[a-z0-9][a-z0-9\-]{0,62})*$/i;
/* JSSTYLED */
var IP_RE = /^(([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/;
var MAX_LIST_VMS_LIMIT = 1000;
var PCI_SLOT_RE = /^[0-9]{1,3}\:[0-9]{1,2}\:[0-7]$/;
var PCI_SLOT_DEV_RESERVED = [0, 6, 30, 31];
var PW_SUFFIX = /^(.*)_pw$/;
var RAM_RE = /^0$|^([1-9][0-9]*$)/;
var TRITON_TAG_ROOT_RE = /^triton\./;
var UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
var VOLUME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_\.\-]+$/;

exports.MAX_LIST_VMS_LIMIT = MAX_LIST_VMS_LIMIT;

var VALID_VM_BRANDS = [
    'bhyve',
    'joyent',
    'joyent-minimal',
    'kvm',
    'lx'
];

var VALID_VM_STATES = [
    'running',
    'stopped',
    'active',
    'destroyed'
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
        name: 'docker',
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
        name: 'firewall_rules',
        mutable: false
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
        name: 'init_name',
        mutable: false
    },
    {
        name: 'internal_metadata',
        mutable: false
    },
    {
        name: 'kernel_version',
        mutable: false
    },
    {
        name: 'limit_priv',
        mutable: true
    },
    {
        name: 'locality',
        mutable: false
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
        name: 'last_modified',
        internal: true
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
        name: 'state',
        internal: true
    },
    {
        name: 'server_uuid',
        mutable: false
    },
    {
        name: 'tags',
        mutable: true
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
        name: 'volumes',
        mutable: false
    },
    {
        name: 'zfs_data_compression',
        mutable: true
    },
    {
        name: 'zfs_io_priority',
        mutable: true
    },
    {
        name: 'zfs_snapshot_limit',
        mutable: true
    },
    {
        name: 'zlog_max_size',
        mutable: true
    },
    {
        name: 'zone_state',
        internal: true
    }
];
// export it so that it's available to tests
exports.VM_FIELDS = VM_FIELDS;

// Build vm field names lookup table
var VM_FIELD_NAMES_LOOKUP = {};
var allVmFieldsNames = VM_FIELDS.map(function eachVmField(vmField) {
    return vmField.name;
});

allVmFieldsNames.forEach(function (vmField) {
    VM_FIELD_NAMES_LOOKUP[vmField] = 1;
});

var validators = {

    /*
     * Max alias length is 255 chars after base64 encoding, which equals
     * 189 raw chars ( floor(255 / 4) * 3 = 189 ). This is because zonecfg
     * validation puts it in a 256-byte null-terminated buffer.
     */
    alias: createValidateStringFn('alias', {re: ALIAS_RE, max: 189}),

    autoboot: createValidateBooleanFn('autoboot'),

    billing_id: createValidateUUIDFn('billing_id', false),

    brand: createValidateStringsListFn('brand', VALID_VM_BRANDS,
        {required: true}),

    cpu_cap: createValidateNumberFn('cpu_cap'),

    cpu_shares: createValidateNumberFn('cpu_shares'),

    cpu_type: createValidateStringFn('cpu_type'),

    customer_metadata: createValidateMetadataFn('customer_metadata'),

    delegate_dataset: createValidateBooleanFn('delegate_dataset'),

    disk_driver: createValidateStringFn('disk_driver'),

    dns_domain:
        createValidateStringFn('dns_domain', {re: DNS_NAME_RE, max: 255}),

    docker: createValidateBooleanFn('docker'),

    do_not_inventory: createValidateBooleanFn('do_not_inventory'),

    firewall_enabled: createValidateBooleanFn('firewall_enabled'),

    firewall_rules: function (params) {
        var errs = [];

        if (params.firewall_rules === undefined) {
            return errs;
        }

        if (!Array.isArray(params.firewall_rules)) {
            errs.push(errors.invalidParamErrorsElem('firewall_rules',
                'Not an array'));
            return errs;
        }

        // Just do basic validation - we'll rely on lower-level APIs to
        // determine if the rule is syntactically correct or not
        try {
            for (var r in params.firewall_rules) {
                validateFirewallRule(params.firewall_rules[r]);
            }
        } catch (e) {
            errs.push(errors.invalidParamErrorsElem('firewall_rules',
                e.message));
        }

        return errs;
    },

    fs_allowed: createValidateStringFn('fs_allowed'),

    hostname:
        createValidateStringFn('hostname', {re: DNS_NAME_RE, max: 64}),

    indestructible_delegated:
        createValidateBooleanFn('indestructible_delegated'),

    indestructible_zoneroot: createValidateBooleanFn('indestructible_zoneroot'),

    init_name: createValidateStringFn('init_name'),

    internal_metadata: createValidateMetadataFn('internal_metadata'),

    kernel_version: createValidateStringFn('kernel_version'),

    limit_priv: createValidateStringFn('limit_priv'),

    locality: function (params) {
        var errs = [];

        if (params.locality) {
            try {
                validLocality(params.locality);
            } catch (e) {
                errs.push(errors.invalidParamErrorsElem('locality', e.message));
            }
        }

        return errs;
    },

    maintain_resolvers: createValidateBooleanFn('maintain_resolvers'),

    max_locked_memory: createValidateNumberFn('max_locked_memory'),

    max_lwps: createValidateNumberFn('max_lwps'),

    max_physical_memory: createValidateNumberFn('max_physical_memory'),

    max_swap: createValidateNumberFn('max_swap'),

    mdata_exec_timeout: createValidateNumberFn('mdata_exec_timeout', {min: 1}),

    networks: function (params) {
        var errs = [];

        if (params.networks) {
            try {
                params.networks = validNetworks(params.networks, true);
            } catch (e) {
                errs.push(errors.invalidParamErrorsElem('networks', e.message));
            }
        } else {
            errs.push(errors.missingParamErrorsElem('networks'));
        }

        return errs;
    },

    nic_driver: createValidateStringFn('nic_driver'),

    overprovision_cpu: createValidateNumberFn('overprovision_cpu', {min: 1}),

    overprovision_memory: createValidateNumberFn('overprovision_memory',
        {min: 1}),

    owner_uuid: createValidateUUIDFn('owner_uuid', true),

    package_name: createValidateStringFn('package_name'),

    package_version: createValidateStringFn('package_version'),

    quota: createValidateNumberFn('quota'),

    ram: createValidateNumberFn('ram', {min: 1}),

    resolvers: createValidateArrayFn('resolvers'),

    server_uuid: createValidateUUIDFn('server_uuid', false),

    tags: createValidateMetadataFn('tags'),

    ticket: createValidateUUIDFn('ticket', false),

    tmpfs: createValidateNumberFn('tmpfs'),

    uuid: createValidateUUIDFn('uuid', false),

    vcpus: createValidateNumberFn('vcpus', {min: 1}),

    volumes: createValidateVolumes('volumes', false),

    zfs_data_compression: createValidateStringFn('zfs_data_compression'),

    zfs_io_priority: createValidateNumberFn('zfs_io_priority'),

    zfs_snapshot_limit: function (params) {
        var errs = [];

        /*
         * This parameter nominally takes an integer, but it must be
         * also able to take null as a way to disable limits on
         * snapshot.  You can completely restrict snapshots with a
         * value of 0, so 0 can't be used for disabling.
         */
        if (params.zfs_snapshot_limit === undefined) {
            // This should make vmadm(1M) not do anything.  Otherwise,
            // any UpdateVM would eliminate snapshot limits.
            delete params.zfs_snapshot_limit;
        } else if (params.zfs_snapshot_limit !== null) {
            // It doesn't seem we can just `return createValidateNumberFn()`.
            var error;

            error = validNumber(params.zfs_snapshot_limit);
            if (error) {
                errs.push(errors.invalidParamErrorsElem(
                    params.zfs_snapshot_limit,
                    'Not a valid number: ' + error.message));
            } else {
                params.zfs_snapshot_limit = Number(params.zfs_snapshot_limit);
            }
        }

        return errs;
    },

    zlog_max_size: createValidateNumberFn('zlog_max_size')

};


/*
 * This ugly hack can change certain defaults used by functions in this file.
 * It can be removed if the validations are refactored into a more typical
 * object returned from a constructor function.
 */
function init(options) {
    assert.optionalObject(options, 'options');

    if (options && options.docker_tag_re) {
        DOCKER_TAG_RE = new RegExp(options.docker_tag_re);
    }
}

exports.init = init;


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
                    errs.push(errors.invalidParamErrorsElem(field));
                }
            }
        }

        return errs;
    };
}


/*
 * Returns a validateArray function
 */
function createValidateArrayFn(field, options) {
    assert.string(field, 'field');

    return function validateArray(params) {
        var errs = [];

        if (params[field] !== undefined && !Array.isArray(params[field])) {
            errs.push(errors.invalidParamErrorsElem(field, 'Not an array'));
        }

        return errs;
    };
}


/*
 * Returns a validateString function
 */
function createValidateStringFn(field, options) {
    var regexp;

    assert.string(field, 'field');

    options = options || {};
    assert.object(options, 'options');

    assert.optionalObject(options.re, 'options.re');
    assert.optionalFinite(options.min, 'options.min');
    assert.optionalFinite(options.max, 'options.max');

    return function (params) {
        var errs = [];

        if (options.required && params[field] === undefined)
            errs.push(errors.missingParamErrorsElem(field));

        if (params[field] !== undefined) {
            if (typeof (params[field]) !== 'string') {
                errs.push(errors.invalidParamErrorsElem(field,
                    'Not a valid string'));
            }

            if (options.min !== undefined && params[field].length < options.min)
                errs.push(errors.invalidParamErrorsElem(field,
                    'String is shorter than minimum of ' + options.min +
                    ' characters'));
            if (options.max !== undefined && params[field].length > options.max)
                errs.push(errors.invalidParamErrorsElem(field,
                    'String is longer than maximum of ' + options.max +
                    ' characters'));
            regexp = options.re;
            if (regexp && !regexp.test(params[field]))
                errs.push(errors.invalidParamErrorsElem(field,
                    'String does not match regexp: ' + regexp));
        }

        return errs;
    };
}


/*
 * Returns a validateNumber function
 */
function createValidateNumberFn(field, options) {
    options = options || {};
    assert.object(options);

    return function (params) {
        var errs = [];
        var error;

        if (options.required && params[field] === undefined)
            errs.push(errors.missingParamErrorsElem(field));

        if (params[field] !== undefined) {
            error = validNumber(params[field], options);
            if (error) {
                errs.push(errors.invalidParamErrorsElem(field,
                    'Not a valid number: ' + error.message));
            } else {
                params[field] = Number(params[field]);
            }
        }

        return errs;
    };
}


/*
 * Returns a validateBoolean function
 */
function createValidateBooleanFn(field, options) {
    options = options || {};
    assert.object(options, 'options');

    return function (params) {
        var errs = [];

        if (options.required && params[field] === undefined)
            errs.push(errors.missingParamErrorsElem(field));

        if (params[field] !== undefined &&
            typeof (params[field]) !== 'boolean') {
            if (['true', 'false'].indexOf(params[field]) === -1)
                errs.push(errors.invalidParamErrorsElem(field));
            else
                params[field] = params[field] === 'true';
        }

        return errs;
    };
}

function createValidateStringsListFn(field, list, options) {
    options = options || {};
    assert.object(options, 'options');
    assert.string(field, 'field');
    assert.arrayOfString(list, 'list');

    var sortedList = jsprim.deepCopy(list).sort();

    return function (params) {
        var errs = [];

        if (options.required && params[field] === undefined)
            errs.push(errors.missingParamErrorsElem(field));

        if (params[field] !== undefined && list.indexOf(params[field]) === -1) {
            var message = 'Must be one of: ' + sortedList.join(', ');
            errs.push(errors.invalidParamErrorsElem(field, message));
        }

        return errs;
    };
}

function createValidateJSONPredicateFn(field, options) {
    assert.string(field, 'field');
    options = options || {};

    return function (params) {
        var jsonPredicate = params[field];
        var predicate = null;
        var errs = [];

        if (options.required && jsonPredicate === undefined)
            errs.push(errors.missingParamErrorsElem(field));

        if (jsonPredicate) {
            try {
                predicate = JSON.parse(jsonPredicate);
            } catch (parseErr) {
                errs.push(errors.invalidParamErrorsElem('predicate',
                    'Unable to parse predicate as JSON'));
                return errs;
            }

            if (Object.keys(predicate).length === 0) {
                errs.push(errors.invalidParamErrorsElem('predicate',
                    'Empty predicate'));
            }

            try {
                predicateUtils.predValidateSyntax(predicate);
            } catch (syntaxError) {
                errs.push(errors.invalidParamErrorsElem('predicate',
                    'Predicate syntax error: ' + syntaxError));
            }
        }

        return errs;
    };
}

/*
 * Validates if a string is a UUID
 */
function validUUID(theUuid) {
    return UUID_RE.test(theUuid);
}
exports.validUUID = validUUID;

function createValidateTimestampFn(field, options) {
    assert.string(field, 'field');
    options = options || {};
    assert.object(options, 'options');

    return function (params) {
        var errs = [];
        var timestamp = params[field];
        if (options.required && timestamp === undefined)
            errs.push(errors.missingParamErrorsElem(field));

        if (timestamp !== undefined) {
            if (!validTimestamp(timestamp)) {
                errs.push(errors.invalidParamErrorsElem(field,
                    'Invalid timestamp: ' + timestamp));
            } else {
                params[field] = jsprim.parseDateTime(params[field]).getTime();
            }
        }

        return errs;
    };
}

/*
 * Validate that the polymorphic parameter with name "paramName" has a key and
 * value that are both valid non-empty strings.
 */
function validatePolymorphicParamStringKeyValue(paramName, key, value) {
    assert.string(paramName, 'paramName');
    assert.optionalString(key, 'key');
    assert.optionalString(value, 'value');

    if (typeof (key) !== 'string' || key.length === 0) {
        return errors.invalidParamErrorsElem(paramName,
            'Invalid ' + paramName + ' key: ' + JSON.stringify(key));
    }
    if (typeof (value) !== 'string' || value.length === 0) {
        return errors.invalidParamErrorsElem(paramName,
            'Invalid ' + paramName + ' value: ' + JSON.stringify(value));
    }
}

function createValidatePolymorphicParamFn(options) {
    options = options || {};
    assert.object(options, 'options');
    assert.string(options.paramName, options.paramName);
    assert.func(options.validationFunc, 'options.validationFunc');

    var paramNameToTest = options.paramName;
    var validationFunc = options.validationFunc;

    return function validatePolymorphicParam(params) {
        var errs = [];
        var validationErr;
        /*
         * E.g 'tag.some_tag_name' or 'internal_metadata.docker:cmd'.
         */
        var fullyQualifiedParamName;
        var paramKey;
        var paramValue;

        for (fullyQualifiedParamName in params) {
            paramKey = polymorphicParamKey(fullyQualifiedParamName);

            if (polymorphicParamName(fullyQualifiedParamName) ===
                paramNameToTest) {
                paramValue = params[fullyQualifiedParamName];
                validationErr = validationFunc(paramNameToTest,
                        paramKey, paramValue);
                if (validationErr) {
                    errs.push(validationErr);
                }
            }
        }

        return errs;
    };
}

function createValidateCSVFn(field, validator, options) {
    assert.string(field, 'field');
    assert.func(validator, 'validator');

    options = options || {};
    assert.object(options, 'options');

    return function (params) {
        var errs = [];
        var csValues = params[field];
        var allValuesValid = true;

        if (options.required && csValues === undefined)
            errs.push(errors.missingParamErrorsElem(field));

        if (csValues !== undefined) {
            allValuesValid = csValues.split(',').every(validator);
            if (!allValuesValid) {
                errs.push(errors.invalidParamErrorsElem(field,
                    'Invalid values: ' + csValues));
            }
        }

        return errs;
    };
}

function createValidateVmFieldsFn(field, options) {
    assert.string(field, 'field');
    options = options || {};
    assert.object(options, 'options');

    return function (params) {
        var errs = [];
        var csValues = params[field];
        var allValuesValid = true;

        if (options.required && csValues === undefined)
            errs.push(errors.missingParamErrorsElem(field));

        if (csValues !== undefined) {
            allValuesValid = csValues.split(',').every(validVmField);
            if (!allValuesValid) {
                errs.push(errors.invalidParamErrorsElem(field,
                    'Invalid values: ' + csValues));
            }
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
            errs.push(errors.missingParamErrorsElem(field));
        } else if (params[field] !== undefined &&
            !validUUID(params[field])) {
            errs.push(errors.invalidUuidErrorsElem(field));
        }

        return errs;
    };
}

function createValidateSortFn(field, options) {
    assert.string(field, 'field');
    options = options || {};
    assert.object(options, 'options');

    return function (params) {
        var errs = [];
        var sortString = params[field];

        if (options.required && sortString === undefined)
            errs.push(errors.missingParamErrorsElem(field));

        if (sortString !== undefined &&
            !sortValidation.isValidSortCriteria(sortString)) {
            errs.push(errors.invalidParamErrorsElem(field,
                'Invalid sort param: ' + sortString));
        }

        return errs;
    };
}

function createValidateMarkerFn(field, options) {
    assert.string(field, 'field');
    options = options || {};
    assert.object(options, 'options must be an object');

    return function (params) {
        var errs = [];
        var markerString = params[field];
        var marker;
        var markerParseRes;
        var markerParseErrors = [];
        var markerValidationErrs;
        var sortParamName = options.sortParamName;
        var sortString;

        if (options.required && markerString === undefined) {
            errs.push(errors.missingParamErrorsElem(field));
        } else if (markerString !== undefined) {
            markerParseRes = markerUtils.parseMarkerJSONString(markerString);
            assert.object(markerParseRes, 'markerParseRes must be an object');
            marker = markerParseRes.marker;
            if (marker === null || marker === undefined) {
                markerParseErrors = markerParseRes.parseErrors;
                assert.arrayOfString(markerParseErrors,
                    'markerParseErrors must be an array of strings');
                markerParseErrors.forEach(function (errorMsg) {
                    errs.push(errors.invalidParamErrorsElem(field,
                        'Invalid marker: ' + markerString + '. ' + errorMsg));
                });
            } else {
                if (sortParamName !== undefined)
                    sortString = params[sortParamName];

                markerValidationErrs =
                    markerUtils.validateMarker(marker, sortString);
                markerValidationErrs.forEach(function (errorMsg) {
                    errs.push(errors.invalidParamErrorsElem(field,
                        'Invalid marker: ' + markerString + '. ' + errorMsg));
                });
            }
        }

        if (errs.length === 0)
            params.marker = marker;

        return errs;
    };
}

function validVolumeName(volumeName) {
    if (volumeName === undefined || volumeName === null ||
        !VOLUME_NAME_RE.test(volumeName)) {
        return false;
    }

    return true;
}

function validVolumeMountpoint(mountpoint) {
    if (typeof (mountpoint) !== 'string') {
        return false;
    }

    /*
     * Must start with '/'.
     */
    if (mountpoint.length === 0 || mountpoint[0] !== '/') {
        return false;
    }

    /*
     * Must not contain the null character.
     */
    if (mountpoint.indexOf('\0') !== -1) {
        return false;
    }

    /*
     * Must contain at least one character that is not '/'.
     */
    if (mountpoint.search(/[^\/]/) === -1) {
        return false;
    }

    return true;
}

function createValidateVolumes(fieldName, required) {
    assert.string(fieldName, 'fieldName');
    assert.optionalBool(required, 'required');

    return function validateVolumesParam(params) {
        var errs = [];
        var idx = 0;
        var VALID_VOLUME_MODES = ['ro', 'rw'];
        var volume;
        var volumes = params[fieldName];

        if (required === false && volumes === undefined) {
            return errs;
        }

        if (!Array.isArray(volumes)) {
            errs.push(errors.invalidParamErrorsElem(fieldName,
                fieldName + ' must be an array of objects'));
            return errs;
        }

        if (volumes.length === 0) {
            errs.push(errors.invalidParamErrorsElem(fieldName,
                fieldName + ' must be a non-empty array of objects'));
        }

        for (idx = 0; idx < volumes.length; ++idx) {
            volume = volumes[idx];
            if (typeof (volume) !== 'object') {
                errs.push(errors.invalidParamErrorsElem(fieldName,
                    fieldName + ' must be a non-empty array of objects'));
            }

            if (volume === null) {
                errs.push(errors.invalidParamErrorsElem(fieldName,
                    fieldName + ' must be a non-empty array of objects'));
            }

            if (volume.mode !== undefined &&
                VALID_VOLUME_MODES.indexOf(volume.mode) === -1) {
                errs.push(errors.invalidParamErrorsElem(fieldName,
                    'volume mode for volume ' + util.inspect(volume) +
                        ' must be one of ' + VALID_VOLUME_MODES.join(', ')));
            }

            if (!validVolumeName(volume.name)) {
                errs.push(errors.invalidParamErrorsElem(fieldName,
                    'Invalid volume name for volume ' + util.inspect(volume)));
            }

            if (!validVolumeMountpoint(volume.mountpoint)) {
                errs.push(errors.invalidParamErrorsElem(fieldName,
                    'Invalid volume mount point for volume ' +
                        util.inspect(volume)));
            }
        }

        return errs;
    };
}
/*
 * Validate an individual element of the firewall_rules array
 */
function validateFirewallRule(rule) {
    if (typeof (rule) !== 'object' || Array.isArray(rule)) {
        throw new Error('Not an array of objects');
    }

    if (rule.uuid === undefined || typeof (rule.uuid) !== 'string' ||
            !validUUID(rule.uuid)) {
        throw new Error('Invalid rule: uuid must be a UUID');
    }

    if (rule.rule === undefined || typeof (rule.rule) !== 'string') {
        throw new Error('Invalid rule: rule must be a string');
    }

    if (rule.global !== undefined) {
        throw new Error('Invalid rule: cannot specify global rules');
    }

    if (rule.owner_uuid === undefined ||
            typeof (rule.owner_uuid) !== 'string' ||
            !validUUID(rule.owner_uuid)) {
        throw new Error('Invalid rule: owner_uuid must be a UUID');
    }

    if (rule.enabled === undefined || typeof (rule.enabled) !== 'boolean') {
        throw new Error('Invalid rule: enabled must be a boolean');
    }
}

function safeBrandName(brandName) {
    assert.string(brandName, 'brandName');

    return (brandName.replace(BRAND_NAME_DISALLOWED_CHARS_RE, '')
        .substr(0, BRAND_NAME_MAX_LENGTH));
}
// export for tests
exports._safeBrandName = safeBrandName;

/*
 * Validate that the given PAPI package (`params.billing_id`) is appropriate
 * for the given provision `params`. Validation error items
 * (i.e. for including in the "errors" array for an API error response per
 * https://github.com/joyent/eng/blob/master/docs/index.md#error-handling)
 * should be added to the `errs` array. If there is a error in processing,
 * then `callback(err)`.
 *
 * Side-effects: This may also populate some package-related fields on
 * `params` from the identified PAPI package.
 */
function validatePackageValues(papi, params, errs, callback) {
    assert.uuid(params.billing_id, 'params.billing_id');
    assert.string(params.brand, 'params.brand');
    assert.array(errs, 'errs');

    var isBhyveOrKvm = (['bhyve', 'kvm'].indexOf(params.brand) !== -1);
    var packageFields = ['cpu_cap', 'max_lwps', 'max_physical_memory',
        'max_swap', 'quota', 'vcpus', 'zfs_io_priority'];

    papi.getPackage(params.billing_id, function (err, pkg) {
        if (err) {
            if (verror.hasCauseWithName(err, 'ResourceNotFoundError')) {
                errs.push({
                    field: 'billing_id',
                    code: 'Invalid',
                    message: err.message
                });
                callback();
            } else {
                callback(err);
            }
            return;
        }

        // Check that the package is compatible with this brand.
        if (pkg.brand !== undefined && pkg.brand !== params.brand) {
            errs.push(errors.invalidParamErrorsElem('brand',
                'Package requires brand "' + safeBrandName(pkg.brand) + '", ' +
                'but brand "' + safeBrandName(params.brand) +
                '" was specified'));
        }

        // Allow for manually overriding package params from original
        // provision params
        packageFields.forEach(function (field) {
            if (params[field] === undefined && pkg[field] !== undefined) {
                if (field === 'quota') {
                    if (isBhyveOrKvm) {
                        params.quota = 10;
                        if (params.brand === 'bhyve' && pkg.flexible_disk) {
                            params.flexible_disk_size = Number(pkg.quota);
                            // Do not set 'quota' for flexible disks.
                            delete params.quota;
                        }
                    } else {
                        params.quota = Number(pkg.quota) / 1024;
                    }
                // KVM and bhyve prefer 'ram' instead of 'max_physical_memory'.
                } else if (isBhyveOrKvm && field === 'max_physical_memory') {
                    params.ram = pkg[field];
                } else {
                   params[field] = Number(pkg[field]);
                }
            }
        });

        // Special case for default values
        var pkgRam = pkg.max_physical_memory;
        if (pkgRam !== undefined) {
            if (params.max_physical_memory === undefined) {
                if (isBhyveOrKvm) {
                    params.ram = Number(pkgRam);
                } else {
                    params.max_physical_memory = Number(pkgRam);
                }
            } else if (params.ram === undefined) {
                params.ram = Number(pkgRam);
            }
        }
        pkgRam = params.max_physical_memory || params.ram;

        if (params.cpu_shares === undefined) {
            if (pkg.fss !== undefined) {
                params.cpu_shares = Math.floor(Number(pkg.fss));
                if (isNaN(params.cpu_shares) || pkg.fss === '') {
                    errs.push(errors.invalidParamErrorsElem('cpu_shares',
                        'Package has invalid "fss" (cpu_shares) value'));
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

        callback();
    });
}
// export for tests
exports.validatePackageValues = validatePackageValues;

/*
 * Validates CreateVm parameters
 */
exports.validateCreateVmParams = function (vmapi, params, callback) {
    var errs = [];

    VM_FIELDS.filter(function (field) {
        return !field.internal;
    }).forEach(function (field) {
        var fieldErrs = validators[field.name](params);
        errs = errs.concat(fieldErrs);
    });

    // when no package is passed, we want to validate presence of ram,
    // max_physical_memory and disks (when kvm or bhyve) at least
    if (!params.billing_id) {
        if (['bhyve', 'kvm'].indexOf(params.brand) !== -1 && !params.ram) {
            errs.push(errors.missingParamErrorsElem('ram', 'Is required for ' +
                params.brand));
        } else if (!params.max_physical_memory && !params.ram) {
            errs.push(errors.missingParamErrorsElem('ram'));
        }
    }

    // max_swap
    if (params.max_swap !== undefined && params.max_swap < MIN_SWAP) {
        errs.push(errors.invalidParamErrorsElem('max_swap',
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
    } else {
        params.server_uuid = '';
    }

    if (params.billing_id &&
        params.billing_id !== '00000000-0000-0000-0000-000000000000') {
        asyncFns.push(validatePackage);
    }
    if (params.image_uuid || (params.disks && params.disks[0].image_uuid)) {
        asyncFns.push(validateImage);
    }
    if (params.image_uuid && params.brand === 'lx') {
        asyncFns.push(validateLxBrand);
    }

    function validateUniqueUuid(next) {
        if (params.do_not_inventory && params.vm_migration_target) {
            next();
            return;
        }
        vmapi.moray.getVm({ uuid: params.uuid }, function onGetVm(err, vm) {
            if (err) {
                return next(err);
            }

            if (vm) {
                errs.push(errors.duplicateParamErrorsElem('uuid'));
            }
            return next();
        });
    }

    function validateAlias(next) {
        if (params.do_not_inventory && params.vm_migration_target) {
            next();
            return;
        }
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
                if (verror.hasCauseWithName(err, 'ResourceNotFoundError')) {
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
        validatePackageValues(vmapi.papi, params, errs, next);
    }

    function validateImage(next) {
        var img_uuid = params.image_uuid || params.disks[0].image_uuid;

        vmapi.imgapi.getImage(img_uuid, function (err, image) {
            if (err) {
                if (verror.hasCauseWithName(err, 'ResourceNotFoundError')) {
                    errs.push({
                        field: 'image_uuid',
                        code: 'Invalid',
                        message: err.message
                    });
                    return next();
                } else {
                    return next(err);
                }
            }

            if (image.state !== 'active' || image.disabled !== false) {
                errs.push({
                    field: 'image_uuid',
                    code: 'Invalid',
                    message: 'Image must be active and not disabled'
                });
            } else {
                params.image = image;
            }
            return next();
        });
    }

    function validateLxBrand(next) {
        // Don't need to validate anything for lxd images.
        if (params.image.type === 'lxd') {
            next();
            return;
        }

        var DOCKER_TYPES = ['lx-dataset', 'docker'];

        if (DOCKER_TYPES.indexOf(params.image.type) === -1) {
            errs.push(errors.invalidParamErrorsElem(
                'image_uuid', 'Image type is "' + params.image.type + '\" ' +
                'must be one of: ' + JSON.stringify(DOCKER_TYPES)));
        }

        if (params.kernel_version === undefined) {
            if (params.image.tags && params.image.tags.kernel_version) {
                params.kernel_version = params.image.tags.kernel_version;
            } else {
                errs.push(errors.missingParamErrorsElem(
                    'kernel_version', 'Required for LX zones'));
            }
        }

        return next();
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
        return field.mutable && !field.internal;
    }).forEach(function (field) {
        var fieldErrs = validators[field.name](obj);
        errs = errs.concat(fieldErrs);

        if (obj[field.name] !== undefined && fieldErrs.length === 0) {
            params[field.name] = obj[field.name];
        }
    });

    if (errs.length > 0) {
        return callback(new errors.ValidationFailedError(
            'Invalid VM update parameters', errs));
    }

    // special case for change_owner
    if (obj.new_owner_uuid) {
        if (typeof (obj.new_owner_uuid) === 'string' &&
            validUUID(obj.new_owner_uuid)) {
            params.new_owner_uuid = obj.new_owner_uuid;
        } else {
            errs.push(errors.invalidUuidErrorsElem('new_owner_uuid'));
        }
    }

    if (obj.customer_metadata) {
        try {
            createMetadataObject(vm,
                'customer_metadata',
                params,
                obj.customer_metadata);
            validateMetadataNamespaces(vm, params);
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
            errs.push(errors.invalidParamErrorsElem('update_disks',
                'Not an array'));
        }
    }

    // If there were no parameters passed, fail here before doing any async
    if (Object.keys(params).length === 0) {
        var errMsg = errs.length > 0 ?
            'Invalid VM update parameters' : 'No VM parameters provided';
        return callback(new errors.ValidationFailedError(errMsg, errs));
    }

    function getSubtask() {
        if (params.billing_id !== undefined ||
                params.ram !== undefined ||
                params.max_physical_memory !== undefined) {
            return 'resize';
        } else if (params.new_owner_uuid) {
            return 'change_owner';
        } else if (params.alias) {
            return 'rename';
        }
        return '';
    }

    // Ideally there is no simultaneous subtasks unless requests are
    // manually done
    params.subtask = getSubtask();

    // Async validations
    var asyncFns = [];
    if (params.alias) {
        asyncFns.push(validateAlias);
    }
    if (vm.brand === 'bhyve') {
        asyncFns.push(convertMaxPhysicalMemoryToRam);
    }
    if (params.billing_id) {
        asyncFns.push(validatePackage);
    }
    if (params.subtask === 'resize') {
        if (vm.brand === 'kvm') {
            // Not allowed for kvm at the moment
            errs.push(errors.invalidParamErrorsElem('brand',
                'Cannot resize a ' + vm.brand + ' VM'));
        } else {
            asyncFns.push(validateImageConstraints);
            asyncFns.push(validateCapacity);
        }
        if (vm.brand === 'bhyve') {
            asyncFns.push(validateBhyveFlexibleDiskPackage);
            asyncFns.push(validateBhyveStopped);
        }
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

    function convertMaxPhysicalMemoryToRam(next) {
        assert.equal(vm.brand, 'bhyve', 'Should only be called for bhyve');
        // Change max_physical_memory into ram.
        if (params.max_physical_memory) {
            params.ram = params.max_physical_memory;
            delete params.max_physical_memory;
        }
        next();
    }

    function validatePackage(next) {
        // Add brand to params, as it is needed when the package has a brand
        // value set.
        params.brand = vm.brand;
        // Note that validatePackageValues has a side affect of loading the
        // package into params.package.
        validatePackageValues(vmapi.papi, params, errs, next);
    }

    function validateImageConstraints(next) {
        // First get image from IMGAPI and resort to CNAPI if the image only
        // exists in the server. This can be the case for customer created
        // images that can be deleted from the IMGAPI repository.
        var image_uuid = vm.image_uuid;
        if (['bhyve', 'kvm'].indexOf(vm.brand) !== -1) {
            image_uuid = vm.disks && vm.disks[0] && vm.disks[0].image_uuid;
        }
        if (!image_uuid) {
            errs.push(errors.invalidParamErrorsElem(
                'VM is missing an image_uuid'));
            next();
            return;
        }

        vmapi.imgapi.getImage(image_uuid, function (err, image) {
            if (err) {
                if (verror.hasCauseWithName(err, 'ResourceNotFoundError')) {
                    return vmapi.cnapi.getImage(
                        vm.server_uuid,
                        image_uuid,
                        onImage);
                } else {
                    return next(err);
                }
            }
            return onImage(null, image);
        });

        function onImage(err, image) {
            if (err) {
                if (verror.hasCauseWithName(err, 'ResourceNotFoundError')) {
                    errs.push(errors.invalidParamErrorsElem(
                        'image_uuid',
                        err.message));
                    return next();
                } else {
                    return next(err);
                }
            }

            var newRam = params.ram || params.max_physical_memory;
            var reqs = image.requirements;

            var maxRam = reqs && reqs.max_ram;
            var minRam = reqs && reqs.min_ram;

            if (maxRam && newRam > maxRam) {
                errs.push(errors.invalidParamErrorsElem(
                    'ram',
                    'Specified RAM (' + newRam + ') does not meet the maximum' +
                    ' RAM requirement (' + maxRam + ')'));
            } else if (minRam && newRam < minRam) {
                errs.push(errors.invalidParamErrorsElem(
                    'ram',
                    'Specified RAM (' + newRam + ') does not meet the minimum' +
                    ' RAM requirement (' + minRam + ')'));
            }
            return next();
        }
    }

    function validateCapacity(next) {
        // obj == req.params
        if (obj.force === true || obj.force === 'true') {
            vmapi.log.info('Forced resize operation called for %s', obj.uuid);
            return next();
        }

        var currentRam = vm.ram || vm.max_physical_memory;
        var requiredRam = params.ram || params.max_physical_memory;
        var neededRam = requiredRam - currentRam;

        var currentDisk = vm.quota;
        var requiredDisk = params.quota;

        // Flexible disks do not use quota, they use the 'flexible_disk_size'
        // property instead, but we must also allow resizing from a vm that
        // doesn't yet use flexible disk (i.e. it still uses quota). Note also
        // that vm.quota uses GiB and vm.flexible_disk_size uses MiB!
        if (vm.brand === 'bhyve' && params.flexible_disk_size) {
            requiredDisk = params.flexible_disk_size / 1024;
            if (vm.flexible_disk_size) {
                currentDisk = vm.flexible_disk_size / 1024;
            }
        }

        vmapi.cnapi.capacity([ vm.server_uuid ], function (err, cap) {
            if (err) {
                return next(err);
            }

            // If the /capacity endpoint in CNAPI returns an empty object (eg.
            // because the server is reserved) we'll just consider the server
            // to have no capacity.
            if (!cap.capacities.hasOwnProperty(vm.server_uuid) ||
                !cap.capacities[vm.server_uuid].hasOwnProperty('ram') ||
                !cap.capacities[vm.server_uuid].hasOwnProperty('disk')) {

                errs.push(errors.insufficientCapacityErrorsElem(
                    'server',
                    'Unable to determine server capacity'));
                return next();
            }

            var sram = cap.capacities[vm.server_uuid].ram;
            var sdisk = Math.floor(cap.capacities[vm.server_uuid].disk / 1024);

            if (currentRam < requiredRam && sram < neededRam) {
                errs.push(errors.insufficientCapacityErrorsElem(
                    'ram',
                    'Required additional RAM (' + neededRam + ') exceeds the ' +
                    'server\'s available RAM (' + sram + ')'));
            }

            if (!requiredDisk) {
                return next();
            }

            // Some VMs do not have quotas; they need to be treated
            // pessimistically.
            if (currentDisk) {
                var neededDisk = requiredDisk - currentDisk;

                if (currentDisk < requiredDisk && sdisk < neededDisk) {
                    errs.push(errors.insufficientCapacityErrorsElem(
                        'quota',
                        'Required additional disk (' + neededDisk + ') ' +
                        'exceeds the server\'s available disk (' + sdisk +
                        ')'));
                }
            } else {
                if (sdisk < requiredDisk) {
                    errs.push(errors.insufficientCapacityErrorsElem(
                        'quota',
                        'Required disk (' + requiredDisk + ') exceeds the ' +
                        'server\'s available disk (' + sdisk + ')'));
                }
            }

            return next();
        });
    }

    // Bhyve cannot change from a flex disk package to one without flex disk.
    function validateBhyveFlexibleDiskPackage(next) {
        assert.equal(vm.brand, 'bhyve', 'Should only be called for bhyve vms');

        // Note: params.package gets side-loaded by the validatePackageValues
        // call.
        var flexible_disk_size = params.flexible_disk_size ||
            (params.package && params.package.flexible_disk &&
            params.package.quota);

        if (!vm.flexible_disk_size) {
            // Instances that do not already use flexible disk can only be
            // resized if they are moving to use flexible disk (either via the
            // package or via the flexible_disk_size param).
            if (!flexible_disk_size) {
                next(new errors.ValidationFailedError('Cannot resize bhyve ' +
                    'instance to a package that does not use flexible disk',
                    [ errors.invalidParamErrorsElem('flexible_disk_size') ]));
                return;
            }
        }

        if (params.package && !params.package.flexible_disk) {
            next(new errors.ValidationFailedError('Cannot resize bhyve ' +
                'instance to a package that does not use flexible disk',
                [ errors.invalidParamErrorsElem('billing_id') ]));
            return;
        }

        // Validate that the current disk size(s) do not exceed the total
        // flexible_disk_size.
        var totalDiskSizeMb = vm.disks.map(
            function (disk) {
                return disk.size || 0;
            }).reduce(function (size, runningTotal) {
                return size + runningTotal;
            }, 0);
        // Add snapshot sizes.
        totalDiskSizeMb += (vm.snapshots || []).map(
            function (snap) {
                return snap.size || 0;
            }).reduce(function (size, runningTotal) {
                return size + runningTotal;
            }, 0);
        // Round up to the nearest whole number.
        totalDiskSizeMb = Math.ceil(totalDiskSizeMb);

        if (totalDiskSizeMb > flexible_disk_size) {
            next(new errors.ValidationFailedError('Cannot resize bhyve ' +
                'instance, existing disk usage (' + totalDiskSizeMb +
                ') exceeds the flexible disk size (' +
                flexible_disk_size + ')',
                [ errors.invalidParamErrorsElem('flexible_disk_size') ]));
            return;
        }

        next();
    }

    // If changing the amount of CPU, or changing the amount of memory in a
    // bhyve instance, then ensure the instance is stopped.
    function validateBhyveStopped(next) {
        assert.equal(vm.brand, 'bhyve', 'Should only be called for bhyve vms');

        if (vm.state === 'stopped') {
            next();
            return;
        }

        var cpuAndMemFields = ['cpu_cap', 'max_lwps', 'ram',
            'max_swap', 'vcpus'];

        if (cpuAndMemFields.some(
            function (field) {
                var val = params[field];
                if (val === undefined) {
                    return false;
                }
                return val !== vm[field];
            }))
        {
            next(new errors.VmNotStoppedError('changing bhyve CPU or memory ' +
                'requires the instance to be stopped'));
            return;
        }

        next();
    }

    async.series(asyncFns, function (err) {
        if (err) {
            return callback(err);
        }

        if (errs.length) {
            return callback(
                new errors.ValidationFailedError('Invalid VM update parameters',
                    errs));
        }
        return callback(null, params);
    });
};

function validateListVmsParams(params, callback) {
    async.series([
        function validateSingleParams(next) {
            var listVmValidators = {
                alias: createValidateStringFn('alias', {re: ALIAS_RE}),
                billing_id: createValidateUUIDFn('billing_id'),
                brand: createValidateStringsListFn('brand', VALID_VM_BRANDS),
                create_timestamp: createValidateTimestampFn('create_timestamp'),
                docker: createValidateBooleanFn('docker'),
                fields: createValidateVmFieldsFn('fields'),
                image_uuid: createValidateUUIDFn('image_uuid'),
                internal_metadata: createValidatePolymorphicParamFn({
                    paramName: 'internal_metadata',
                    validationFunc: validatePolymorphicParamStringKeyValue
                }),
                limit: createValidateNumberFn('limit',
                    {min: 1, max: MAX_LIST_VMS_LIMIT}),
                marker: createValidateMarkerFn('marker',
                    {sortParamName: 'sort'}),
                offset: createValidateNumberFn('offset'),
                owner_uuid: createValidateUUIDFn('owner_uuid'),
                package_name: createValidateStringFn('package_name'),
                package_version: createValidateStringFn('package_version'),
                predicate: createValidateJSONPredicateFn('predicate'),
                query: createValidateStringFn('query'),
                ram: createValidateStringFn('ram', {re: RAM_RE}),
                server_uuid: createValidateUUIDFn('server_uuid'),
                sort: createValidateSortFn('sort'),
                state: createValidateStringsListFn('state', VALID_VM_STATES),
                tag: createValidatePolymorphicParamFn({
                    paramName: 'tag',
                    validationFunc: validatePolymorphicParamStringKeyValue
                }),
                uuid: createValidateUUIDFn('uuid'),
                uuids: createValidateCSVFn('uuids', validUUID)
            };

            return validateParams(listVmValidators, params, {strict: true},
                next);
        },
        function validateConflictingParams(next) {
            var errs = [];
            if (params.offset && params.marker) {
                errs.push(errors.conflictingParamsErrorsElem(
                    ['offset', 'marker'],
                    'offset and marker cannot be used at the same time'));
            }

            if (errs.length > 0)
                return next(errs);

            return next();
        }], callback);
}
exports.validateListVmsParams = validateListVmsParams;

function validTimestamp(timestamp) {
    // Try the ISO string form
    var date = new Date(timestamp);
    if (!isNaN(date.getTime()))
        return true;

    // Try the miliseconds since epoch form
    date = new Date(Number(timestamp));
    if (!isNaN(date.getTime()))
        return true;

    return false;
}

exports.validTimestamp = validTimestamp;

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

// Just make sure it works in case someone decides to send 'false'
function isPrimary(prm) {
    return (prm === undefined ? false : (prm === true || prm === 'true'));
}


/*
 * Validates if a comma separated string contains UUIDs
 * If isProvision is true then it will assume a new VM that has no NICs yet,
 * therefore marking the first NIC as primary if not explicitly done for others.
 * If isProvision is false it means that we can't deafult a NIC as primary
 *
 * The history of this format has changed over some time. The original 'legacy'
 * way is the form of:
 *
 * [ uuid_0, uuid_1, ... ]
 *
 * The next iteration of this looks like:
 *
 * [ { uuid: uuid_0, primary: true }, { uuid: uuid_1, ip: ip_1 }, ... ]
 *
 * Importantly that form allowed us to request an IP address and to set which
 * nic is the primary. However, we want to allow the API to evolve into
 * something that's more IPv6 friendly and allows us to specify multiple IPv6
 * IPs.
 *
 * The new form of this is going to look like:
 *
 * [
 *   {
 *     ipv4_uuid: uuid_0, ipv4_count: <number>, ipv4_ips: [ ip0, ip1, ... ],
 *     ipv6_uuid: uuid_1, ipv6_count: <number>, ipv6_ips: [ ip0, ip1, ... ],
 *     primary: true
 *   }, ...
 * ]
 *
 * The idea here is that each object is an interface. Interfaces can be IPv4 and
 * IPv6 uuids. That said, we don't quite support everything here yet. We only
 * support a count of 1 or a single IP in the array. We don't support both of
 * those at this time, though we'll go through and support it later on, the same
 * is true for IPv6. The goal is just to future proof ourselves at the various
 * layers of the stack. And of course, if this never does come to pass, I'll be
 * quite sad, and say I'm sorry.
 */
function validNetworks(object, isProvision) {
    var networks = [];
    var primaries = 0;
    var array, obj;

    if (Array.isArray(object)) {
        array = object;
    } else if (typeof (object) === 'string') {
        array = object.split(',');
    } else {
        throw new Error('Malformed networks object');
    }

    for (var i = 0; i < array.length; i++) {
        obj = array[i];

        // See history of types up above
        if (typeof (obj) === 'string') {
            obj = { ipv4_uuid: obj, ipv4_count: 1 };
        } else {
            if (isPrimary(obj.primary)) {
                primaries++;
            }

            if ('uuid' in obj && ('ipv4_uuid' in obj || 'ipv6_uuid' in obj)) {
                throw new Error('Network object uses both old uuid form and ' +
                    'new ipvX_uuid form');
            }

            if ('uuid' in obj) {
                obj['ipv4_uuid'] = obj['uuid'];
                delete obj['uuid'];
                if ('ip' in obj) {
                    obj['ipv4_ips'] = [ obj['ip'] ];
                    delete obj['ip'];
                } else {
                    obj['ipv4_count'] = 1;
                }
            } else {
                if ('ipv6_uuid' in obj || 'ipv6_count' in obj ||
                    'ipv6_ips' in obj) {
                     throw new Error('IPv6 options are not currently ' +
                         'supported');
                }
                if ('ipv4_count' in obj && 'ipv4_ips' in obj) {
                    throw new Error('cannot specify both an IP count and ' +
                        'specific IPs');
                }

                if ('ipv4_count' in obj) {
                    if (typeof (obj['ipv4_count']) !== 'number') {
                        throw new Error('ipv4_count must be a number');
                    }

                    if (obj['ipv4_count'] !== 1) {
                        throw new Error('ipv4_count must be set to one');
                    }
                }

                if ('ipv4_ips' in obj) {
                    if (!Array.isArray(obj['ipv4_ips'])) {
                        throw new Error('ipv4_ips must be an array');
                    }

                    if (obj['ipv4_ips'].length !== 1) {
                        throw new Error('ipv4_ips may only have a single ' +
                            'entry');
                    }

                    for (var j = 0; j < obj['ipv4_ips'].length; j++) {
                        if (net.isIPv4(obj['ipv4_ips'][j]) !== true) {
                            throw new Error('ipv4_ips contains invalid IPv4 ' +
                                'addresses');
                        }
                    }
                }

                if (!('ipv4_count' in obj) && !('ipv4_ips' in obj)) {
                    obj['ipv4_count'] = 1;
                }
            }
        }

        if (obj.ipv4_uuid && !validUUID(obj.ipv4_uuid)) {
            throw new Error(format('Invalid uuid %s', obj.uuid));
        } else if (!obj.ipv4_uuid && !obj.name) {
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

    var additionalParams = ['allow_dhcp_spoofing', 'allow_ip_spoofing',
        'allow_mac_spoofing', 'allow_restricted_traffic'];
    var whitelistAttrs = additionalParams.concat('mac', 'interface', 'primary');

    var nic;
    for (var i = 0; i < array.length; i++) {
        nic = {};
        obj = array[i];

        // Verify the list of fields passed through a whitelist to make sure
        // users are informed when providing incorrect properties
        for (var key in obj) {
            if (whitelistAttrs.indexOf(key) === -1) {
                throw new Error(
                    format('\'%s\' is not a valid property to update', key));
            }
        }

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

        additionalParams.forEach(function (addlParam) {
            if (obj.hasOwnProperty(addlParam)) {
                nic[addlParam] = obj[addlParam];
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
 * Validates if locality object is understandable by DAPI.
 */
function validLocality(object) {
    if (!object || typeof (object) !== 'object') {
        throw new Error('malformed locality object');
    }

    var check = function (hintName) {
        var hint = object[hintName];

        if (!hint) {
            return;
        }

        if (typeof (hint) !== 'string' && !Array.isArray(hint)) {
            throw new Error('locality entry is neither string nor array');
        }

        if (typeof (hint) === 'string' && !validUUID(hint)) {
            throw new Error('locality contains malformed UUID');
        }

        if (Array.isArray(hint)) {
            for (var i = 0; i !== hint.length; i++) {
                if (!validUUID(hint[i])) {
                    throw new Error('locality contains malformed UUID');
                }
            }
        }
    };

    check('near');
    check('far');

    return object;
}

exports.validLocality = validLocality;



/*
 * Validates if an alias is url compatible
 */
function validAlias(alias) {
    return ALIAS_RE.test(alias);
}

exports.validAlias = validAlias;



/*
 * Validates that vm brand is one we know about.
 */
function validBrand(brand) {
    return VALID_VM_BRANDS.indexOf(brand) != -1;
}

exports.validBrand = validBrand;



/*
 * Validates if a param is a valid number. Takes two parameters:
 *
 * - param: a String representing a number.
 * - options: an object with properties that change the validation performed
 *   on "param":
 *   - options.min: the minimum value that the number represented by "param"
 *     can have to be considered valid.
 *   - options.max: the maximum value that the number represented by "param"
 *     can have to be considered valid.
 */
function validNumber(param, options) {
    options = options || {};
    assert.object(options, 'options');

    if (options.min === null || options.min === undefined)
        options.min = 0;

    assert.optionalFinite(options.min);
    assert.optionalFinite(options.max);

    var number = parseInt(param, 10);
    var withinBounds = true;
    var errorMsgs = [];

    if (options.min !== null && options.min !== undefined) {
        withinBounds = number >= options.min;
    }

    if (withinBounds && options.max !== null && options.max !== undefined) {
        withinBounds = number <= options.max;
    }

    if (!withinBounds) {
        if (options.min !== undefined)
            errorMsgs.push('>= ' + options.min);

        if (options.max !== undefined)
            errorMsgs.push('<= ' + options.max);

        return new Error('number must be ' + errorMsgs.join(' and '));
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
            var error = [ errors.invalidUuidErrorsElem('owner_uuid') ];
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
 * Validates if a metadata object contains only strings, numbers or booleans.
 *
 * If preventDocker flag is set, return error if any tags match DOCKER_TAG_RE.
 */
function validMetadata(name, obj, preventDocker) {
    var types = ['string', 'boolean', 'number'];
    var error;

    for (var key in obj) {
        if (types.indexOf(typeof (obj[key])) == -1) {
            error = [ errors.invalidParamErrorsElem(name + '.' + key,
                'Forbidden Data Type') ];
            throw new errors.ValidationFailedError(
                'Invalid Parameter', error);
        } else if (name === 'customer_metadata' && PW_SUFFIX.test(key)) {
            error = [ errors.invalidParamErrorsElem(name + '.' + key,
                'Forbidden Metadata Key') ];
            throw new errors.ValidationFailedError(
                'Invalid Parameter', error);
        }
    }

    if (name === 'tags') {
        var errMsg = validTags(obj, preventDocker);
        if (errMsg) {
            error = [ errors.invalidParamErrorsElem(name, errMsg) ];
            throw new errors.ValidationFailedError('Invalid Parameter', error);
        }
    }

    return true;
}

exports.validMetadata = validMetadata;



/*
 * Check that any tags set on a VM are valid.
 *
 * Primarily we check that only valid keys go under triton.*, and that none
 * of Docker's special tags can be set.
 */
function validTags(tags, preventDocker) {
    for (var key in tags) {
        if (tritonTags.isTritonTag(key)) {
            var data = tags[key];
            var errMsg = tritonTags.validateTritonTag(key, data);
            if (errMsg !== null) {
                return errMsg;
            }
        } else if (preventDocker && key.match(DOCKER_TAG_RE)) {
            return 'Special tag "' + key + '" not supported';
        }
    }

    return null;
}



/*
 * Check that the metadata being deleted is allowed.
 */
function validDeleteMetadata(metaName, metaKey) {
    if (metaName === 'tags' && metaKey.match(DOCKER_TAG_RE)) {
        var msg = 'Special tag "' + metaKey + '" may not be deleted';
        var error = [ errors.invalidParamErrorsElem(metaName, msg) ];
        throw new errors.ValidationFailedError('Invalid Parameter', error);
    }
}

exports.validDeleteMetadata = validDeleteMetadata;



/*
 * Check that all of the metadata belonging to a tag is deletable.
 */
function validDeleteAllMetadata(metaName, metadata) {
    if (metaName !== 'tags')
        return;

    for (var key in metadata) {
        validDeleteMetadata(metaName, key);
    }
}

exports.validDeleteAllMetadata = validDeleteAllMetadata;



/*
 * Validates if the customer_metadata keys violate the
 * internal_metadata_namespaces restrictions
 */
function validateMetadataNamespaces(vm, params) {
    var namespaces = vm.internal_metadata_namespaces;
    if (!namespaces) {
        return true;
    }

    var invalid = [];
    var custMdataKeys = Object.keys(params.set_customer_metadata);

    for (var i = 0; i < custMdataKeys.length; i++) {
        // foo:id -> 'foo' # not valid
        // foo    -> 'foo' # valid, not namespaced
        var splitted = custMdataKeys[i].split(':');
        if (splitted.length == 1) {
            continue;
        }

        if (namespaces.indexOf(splitted[0]) !== -1) {
            invalid.push(custMdataKeys[i]);
        }
    }

    if (invalid.length) {
        var formattedNs = namespaces.map(function (ns) {
            return '\'' + ns + ':*' + '\'';
        });
        var error = [ errors.invalidParamErrorsElem('customer_metadata',
            format('Invalid metadata keys: %s (protected namespaces: %s)',
                invalid.join(', '), formattedNs)) ];
        throw new errors.ValidationFailedError(
                'Invalid Parameter', error);
    }

    return true;
}

exports.validateMetadataNamespaces = validateMetadataNamespaces;



/*
 * Validates that the disks for the VM have a valid format
 */
function validDisks(disks, brand, errs) {
    var i;
    var ndisks = disks.length;
    var disk0 = disks[0];
    var remaining = false;

    if (disk0.image_uuid === undefined) {
        errs.push(errors.missingParamErrorsElem('disks.0.image_uuid'));
    } else if (!validUUID(disk0.image_uuid)) {
        errs.push(errors.invalidUuidErrorsElem('disks.0.image_uuid'));
    }

    if (disk0.size !== undefined && brand !== 'bhyve') {
        errs.push(errors.invalidParamErrorsElem('disks.0.size', 'Not Allowed'));
    }


    for (i = 1; i < ndisks; i++) {
        var disk = disks[i];

        if (disk.image_uuid !== undefined) {
            errs.push(errors.invalidParamErrorsElem(
                'disks.' + i + '.image_uuid', 'Not Allowed'));
        }

        if (disk.size === undefined) {
            errs.push(errors.missingParamErrorsElem('disks.' + i + '.size'));
        }

        if (isNaN(disk.size)) {
            if (disk.size !== 'remaining') {
                errs.push(errors.invalidParamErrorsElem('disks.' + i + '.size',
                    'Not Allowed'));
            } else {
                if (remaining) {
                    errs.push(errors.invalidParamErrorsElem(
                        'disks.' + i + '.size',
                        'Cannot have more than one disk with size "remaining"'
                    ));
                }
                remaining = true;
            }
        } else if (disk.size <= 0) {
                errs.push(errors.invalidParamErrorsElem('disks.' + i + '.size',
                    'Disk size must be positive'));
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
    if (['bhyve', 'kvm'].indexOf(params.brand) !== -1) {
        if (!params.disks) {
            errs.push(errors.missingParamErrorsElem('disks'));
            return;
        } else if (typeof (params.disks) === 'string') {
            try {
                params.disks = JSON.parse(params.disks);
            } catch (e) {
                errs.push(errors.invalidParamErrorsElem('disks',
                    'Malformed JSON'));
                return;
            }
        }

        if (!Array.isArray(params.disks) || (params.disks.length < 1)) {
            errs.push(errors.invalidParamErrorsElem('disks'));
        } else {
            validDisks(params.disks, params.brand, errs);
        }

    } else {
        // Only non-kvm vms require image_uuid
        if (params.image_uuid === undefined) {
            errs.push(errors.missingParamErrorsElem('image_uuid'));
        } else if (!validUUID(params.image_uuid)) {
            errs.push(errors.invalidUuidErrorsElem('image_uuid'));
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
            error = [errors.invalidParamErrorsElem(mdataKey, 'Malformed JSON')];
            throw new errors.ValidationFailedError('Invalid Parameters', error);
        }
    } else {
        error = [errors.invalidParamErrorsElem(mdataKey, 'Invalid data type')];
        throw new errors.ValidationFailedError('Invalid Parameters', error);
    }

    validMetadata(mdataKey, metadata, true);

    var updateObject = common.setMetadata(vm, mdataKey, metadata);

    var setKey = 'set_' + mdataKey;

    if (updateObject[setKey]) {
        params[setKey] = updateObject[setKey];
    }

    var removeKey = 'remove_' + mdataKey;
    var removals = updateObject[removeKey];

    if (removals) {
        if (mdataKey === 'tags') {
            removals.forEach(function (key) {
                validDeleteMetadata(mdataKey, key);
            });
        }

        params[removeKey] = removals;
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
            var error = errors.duplicateParamErrorsElem('alias', message);
            /* JSSTYLED */
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
            errs.push(errors.invalidParamErrorsElem('networks', e.message));
        }
    } else {
        errs.push(errors.missingParamErrorsElem('networks'));
    }

    if (errs.length) {
        throw new errors.ValidationFailedError('Invalid network parameters',
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
            errs.push(errors.invalidParamErrorsElem('nics', e.message));
        }
    } else {
        errs.push(errors.missingParamErrorsElem('nics'));
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
            errs.push(errors.invalidParamErrorsElem('macs',
                'Invalid MAC addresses object'));
        }
    } else {
        errs.push(errors.missingParamErrorsElem('macs'));
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
 * Simple validation; ensures that pci_slot has the right format and isn't
 * using any reserved device IDs.
 */
exports.validatePciSlot = function validatePciSlot(params) {
    var slot = params.pci_slot;

    function throwErr(err) {
        throw new errors.ValidationFailedError('Invalid VM update parameters',
            [err]);
    }

    if (!slot) {
        throwErr(errors.missingParamErrorsElem('pci_slot'));
    } else if (!PCI_SLOT_RE.test(slot)) {
        throwErr(errors.invalidParamErrorsElem('pci_slot',
            'Not a valid value'));
    }

    var parts = slot.split(':');
    var bus  = +parts[0];
    var dev  = +parts[1];
    var func = +parts[2];

    if (bus < 0 || bus > 255 || dev < 0 || dev > 31 || func < 0 || func > 7) {
        throwErr(errors.invalidParamErrorsElem('pci_slot',
            'Not a valid value'));
    } else if (PCI_SLOT_DEV_RESERVED.indexOf(dev) !== -1) {
        throwErr(errors.invalidParamErrorsElem('pci_slot',
            'Reserved device ID'));
    }

    return true;
};



/*
 * Sets default attributes for a vm on things that depend on
 * RAM or disk for example
 */
exports.setDefaultValues = function (params, options) {
    assert.object(options, 'options');
    assert.object(options.config, 'options.config');
    assert.optionalObject(options.config.overlay, 'options.config.overlay');

    var config = options.config;
    var i;

    if (config.overlay && config.overlay.enabled) {
        params.sdc_nat_pool = config.overlay.natPool;
    }

    if (params.uuid === undefined) {
        params.uuid = uuid.v4();
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

    // Add additional values for bhyve or kvm disks
    if (['bhyve', 'kvm'].indexOf(params.brand) !== -1) {
        // Set the disks to be used to package disks in case none is given:
        if (!params.disks && params.package.disks) {
            params.disks = params.package.disks;
        }

        params.disks[0].image_name = params.image.name;

        if (!params.disks[0].image_size) {
            params.disks[0].image_size = params.image.image_size;
        }


        // We don't set the refreservation via VMAPI for bhyve and instead
        // allow SmartOS to determine the refreservation.
        if (params.brand === 'kvm') {
            // Set a default refreservation for i > 0 disks
            for (i = 1; i < params.disks.length; i++) {
                if (params.disks[i].refreservation === undefined) {
                    if (config.reserveKvmStorage === false) {
                        params.disks[i].refreservation = 0;
                    } else {
                        params.disks[i].refreservation = params.disks[i].size;
                    }
                }
            }
        }
    }
};

function validateParams(customValidators, params, options, callback) {
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    var customValidatorName;
    var paramName;
    var customValidator;
    var validationErrors = [];

    if (options.strict) {
        for (paramName in params) {
            if (!params.hasOwnProperty(paramName)) {
                // Skip inherited properties
                continue;
            }

            customValidatorName = polymorphicParamName(paramName);
            customValidator = customValidators[customValidatorName];
            if (!customValidator) {
                validationErrors.push(
                    new errors.invalidParamErrorsElem(paramName));
            }
        }
    }

    Object.keys(customValidators).forEach(function validate(fieldName) {
        var fieldErrs = customValidators[fieldName](params);
        if (fieldErrs)
            validationErrors = validationErrors.concat(fieldErrs);
    });

    if (validationErrors.length > 0)
        return callback(validationErrors);

    return callback();
}

/*
 * For a given querystring parameter name, returns the validator name
 * as specified in the map of parameters passed to "validateParams".
 * Handles parameters with polymorphic names. For instance, tag parameters
 * that use a dot to separate the parameter name "tag" from the tag key will
 * return "tag", and not "tag.key".
 */
function polymorphicParamName(paramString) {
    assert.string(paramString, 'paramString');

    return paramString.split('.')[0];
}

function polymorphicParamKey(paramString) {
    assert.string(paramString, 'paramString');

    var paramStringCompoments = strsplit(paramString, '.', 2);
    if (paramStringCompoments.length === 2) {
        return paramStringCompoments[1];
    }
}

function validVmField(field) {
    assert.string(field, 'field');

    return VM_FIELD_NAMES_LOOKUP[field] ||
        field === '*' ||
        field === 'role_tags';
}
exports.validVmField = validVmField;

function isSortOrderDescending(order) {
    assert.string(order);
    return order.toUpperCase() === 'DESC';
}
exports.isSortOrderDescending = isSortOrderDescending;
exports.DEFAULT_SORT_ORDER = 'DESC';

function hasPolymorphicParamWithName(fieldName, params) {
    assert.string(fieldName, 'fieldName');
    assert.object(params, 'params');

    var paramName;
    for (paramName in params) {
        if (paramName.indexOf(fieldName + '.') === 0) {
            return true;
        }
    }

    return false;
}
exports.hasPolymorphicParamWithName = hasPolymorphicParamWithName;
