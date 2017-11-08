/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

var assert = require('assert-plus');
var restify = require('restify');
var strsplit = require('strsplit');

var clone = require('./util').clone;

/*
 * Simple parser to get a vm owner by providing its dn.
 */
function vmOwner(dn) {
    var ouuid = '';
    if (!dn) {
        return '';
    }

    dn.split(',').forEach(function (val) {
        var kv = val.split('=');
        // kv -> uuid=xyz
        if (kv[0].replace(/^\s+|\s+$/g, '') == 'uuid') {
            ouuid = kv[1];
        }
    });

    return ouuid;
}

exports.vmOwner = vmOwner;


/*
 * Returns a univeral vm object. The only special case is when the
 * vm object comes from moray. Here we know that the owner_uuid can be
 * parsed from the dn. If not, we call obj.owner_uuid
 *
 * You can pass the fullObject flag to ignore attributes that have not been set.
 * This is useful for vm update operations when you want to modify 'these'
 * properties only
 */
function translateVm(obj, fullObject) {
    assert.ok(obj);

    if (fullObject === undefined) {
        fullObject = false;
    }

    assert.equal(typeof (fullObject), 'boolean');

    try {
        if (typeof (obj.nics) == 'string')
            obj.nics = JSON.parse(obj.nics);
    } catch (e) { }

    try {
        if (typeof (obj.datasets) == 'string')
            obj.datasets = JSON.parse(obj.datasets);
    } catch (e) { }

    try {
        if (typeof (obj.disks) == 'string')
            obj.disks = JSON.parse(obj.disks);
    } catch (e) { }

    try {
        if (typeof (obj.snapshots) == 'string')
            obj.snapshots = JSON.parse(obj.snapshots);
    } catch (e) { }

    try {
        if (typeof (obj.customer_metadata) == 'string')
            obj.customer_metadata = JSON.parse(obj.customer_metadata);
    } catch (e) {}

    try {
        if (typeof (obj.internal_metadata) == 'string')
            obj.internal_metadata = JSON.parse(obj.internal_metadata);
    } catch (e) {}

    // Single tag case OR when reading from string
    if (typeof (obj.tags) === 'string') {
        try {
            obj.tags = JSON.parse(obj.tags);
        } catch (e) {
            obj.tags = tagFormatToObject(obj.tags);
        }
    }

    function dateFromInput(input) {
        return (isNaN(Number(input)) ? new Date(input)
                                     : new Date(Number(input)));
    }

    var timestamps = ['create_timestamp', 'last_modified', 'destroyed' ];
    timestamps.forEach(function (key) {
        if (obj[key]) {
            obj[key] = dateFromInput(obj[key]);
        }
    });

    /*
     * Since we're always including these fields in objects, even when they
     * don't exist in the moray objects, vm-agent needs to know which fields are
     * included. It has an VMAPI_ALWAYS_SET_FIELDS property which should be
     * updated whenever fields are added/removed from this vm object.
     */
    var vm = {
        uuid: obj.uuid,
        alias: obj.alias,
        autoboot: obj.autoboot,
        brand: obj.brand,
        billing_id: obj.billing_id,
        cpu_cap: obj.cpu_cap,
        cpu_shares: obj.cpu_shares,
        create_timestamp: obj.create_timestamp,
        customer_metadata: obj.customer_metadata,
        datasets: obj.datasets,
        destroyed: obj.destroyed,
        firewall_enabled: obj.firewall_enabled,
        internal_metadata: obj.internal_metadata,
        last_modified: obj.last_modified,
        limit_priv: obj.limit_priv,
        max_locked_memory: obj.max_locked_memory,
        max_lwps: obj.max_lwps,
        max_physical_memory: obj.max_physical_memory,
        max_swap: obj.max_swap,
        nics: obj.nics,
        owner_uuid: vmOwner(obj.dn) || obj.owner_uuid,
        platform_buildstamp: obj.platform_buildstamp,
        quota: obj.quota,
        ram: obj.ram,
        resolvers: obj.resolvers,
        server_uuid: obj.server_uuid,
        snapshots: obj.snapshots,
        state: obj.state,
        tags: obj.tags,
        zfs_filesystem: obj.zfs_filesystem,
        zfs_io_priority: obj.zfs_io_priority,
        zone_state: obj.zone_state,
        zonepath: obj.zonepath,
        zpool: obj.zpool
    };

    var optionalFields = [
        'boot_timestamp',
        'docker',
        'dns_domain',
        'hostname',
        'delegate_dataset',
        'exit_status',
        'exit_timestamp',
        'filesystems',
        'fs_allowed',
        'indestructible_delegated',
        'indestructible_zoneroot',
        'init_name',
        'internal_metadata_namespaces',
        'kernel_version',
        'limit_priv',
        'maintain_resolvers',
        'mdata_exec_timeout',
        'package_name',
        'package_version',
        'pid',
        'tmpfs',
        'zfs_data_compression'
    ];

    optionalFields.forEach(function (field) {
        if (obj[field] || obj[field] === 0 || obj[field] === false) {
            vm[field] = obj[field];
        }
    });

    if (obj.brand === 'kvm') {
        vm.vcpus = obj.vcpus;
        vm.cpu_type = obj.cpu_type;
        vm.disks = obj.disks;
        if (obj.hostname) {
            vm.hostname = obj.hostname;
        }
    } else {
        vm.image_uuid = obj.image_uuid;
    }

    if (fullObject) {
        if (vm.ram === undefined && vm.max_physical_memory !== undefined) {
            vm.ram = vm.max_physical_memory;
        }

        if (vm.firewall_enabled === undefined) {
            vm.firewall_enabled = false;
        }

        Object.keys(vm).forEach(function (key) {
            if (vm[key] === undefined) {
                var value;
                if (key === 'customer_metadata' ||
                    key === 'internal_metadata' || key === 'tags') {
                    value = {};
                } else if (key === 'nics' || key === 'snapshots' ||
                    key === 'datasets') {
                    value = [];
                } else {
                    value = null;
                }

                vm[key] = value;
            }
        });
    } else {
        Object.keys(vm).forEach(function (key) {
            if (vm[key] === undefined || vm[key] === null || vm[key] === '') {
                delete vm[key];
            }
        });
    }

    return vm;
}

exports.translateVm = translateVm;



var SENSIBLE_FIELDS = [
    'dapi_url',
    'napi_url',
    'cnapi_url',
    'vmapi_url',
    'expects'
];

/*
 * Removes sensible fields from job parameters
 */
function sanitizeJobParams(params) {
    var newParams = clone(params);

    for (var i = 0; i < SENSIBLE_FIELDS.length; i++) {
        delete newParams[SENSIBLE_FIELDS[i]];
    }

    return newParams;
}



/*
 * Returns an API job response object
 */
exports.translateJob = function (obj) {
    assert.ok(obj);
    assert.ok(obj.params);

    var job = {
        name: obj.name,
        uuid: obj.uuid,
        execution: obj.execution,
        params: sanitizeJobParams(obj.params),
        exec_after: obj.exec_after,
        created_at: obj.created_at,
        timeout: obj.timeout,
        chain_results: obj.chain_results
    };

    return job;
};


/* BEGIN JSSTYLED */
var BOOLEAN_RE = /^%b\{(true|false)\}$/;
var NUMBER_RE = /^%n\{([-+]?[0-9]*\.?[0-9]+)\}$/;
/* END JSSTYLED */

/*
 * Converts a tag format to a javascript literal
 *
 * "-foo=bar-bar=baz-"
 * => { foo: 'bar', bar: 'baz' }
 *
 * Note: The premise of this whole function is wrong. We shouldn't be
 * parsing tags out of this. The DB (moray) should have the tags as JSON *and*
 * in this processed form. The former for returning the data, the latter
 * for searching. See ZAPI-737.
 */
function tagFormatToObject(string) {
    var i;
    var obj = {};
    var array = string.split('-');

    /*
     * Limitation: This `escapeTagStr/unescapeTagStr`, of course doesn't handle
     * a literal "%2D" or "%3D" in a tag properly. See ZAPI-737 for that.
     */
    var unescapeTagStr = function (s) {
        return s.replace(/%2D/g, '-').replace(/%3D/g, '=');
    };

    if (array.length < 3) {
        // TODO: log this
        console.warn('Incorrect tags string format: ' + string);
        return obj;
    }

    for (i = 1; i < (array.length - 1); i++) {
        var tag = strsplit(array[i], '=', 2);
        if (tag.length !== 2) {
            // TODO: log this
            console.warn('WARNING: silently dropping invalid raw tag: %j',
                array[i]);
            continue;
        }

        var raw = unescapeTagStr(tag[1]);
        if (NUMBER_RE.test(raw)) {
            raw = Number(NUMBER_RE.exec(raw)[1]);
        } else if (BOOLEAN_RE.test(raw)) {
            raw = BOOLEAN_RE.exec(raw)[1];
            raw = (raw === 'true' ? true : false);
        }
        obj[unescapeTagStr(tag[0])] = raw;
    }

    return obj;
}

exports.tagFormatToObject = tagFormatToObject;



/*
 * Converts a javascript literal to a tag format string. The literal is expected
 * to have simple string/numeric values for its properties. The tag format looks
 * like the following example:
 *
 * { foo: 'bar', bar: 'baz' }
 * => "-foo=bar-bar=baz-"
 *
 * This means that each tag is enclosed by the - character
 */
function objectToTagFormat(obj) {
    if (!obj || typeof (obj) !== 'object') {
        throw new TypeError('Object required');
    }

    /*
     * Limitation: This `escapeTagStr/unescapeTagStr`, of course doesn't handle
     * a literal "%2D" or "%3D" in a tag properly. See ZAPI-737 for that.
     */
    var escapeTagStr = function (s) {
        // JSSTYLED
        return s.replace(/-/g, '%2D').replace(/=/g, '%3D');
    };

    var values = [];

    Object.keys(obj).forEach(function (key) {
        var value = obj[key];
        if (typeof (value) === 'number') {
            value = '%n{' + value.toString() + '}';
        } else if (typeof (value) === 'boolean') {
            value = '%b{' + value.toString() + '}';
        }
        values.push(escapeTagStr(key) + '=' + escapeTagStr(value));
    });

    return '-' + values.join('-') + '-';
}

exports.objectToTagFormat = objectToTagFormat;



/*
 * Creates a set_metadata object
 */
exports.addMetadata = function (mdataKey, params) {
    var setMdata = {};

    if (Object.keys(params).length === 0) {
        throw new restify.InvalidArgumentError('At least one ' + mdataKey +
          ' key must be provided');
    }

    // This will give you something like this:
    // { set_customer_metadata: { foo: 'bar' } }
    setMdata['set_' + mdataKey] = params;
    return setMdata;
};



/*
 * Creates a set_metadata object that replaces current metadata
 */
exports.setMetadata = function (vm, mdataKey, params) {
    var setMdata = this.addMetadata(mdataKey, params);
    var currentMdata = vm[mdataKey];
    var keysToRemove = [];

    for (var key in currentMdata) {
        if (!setMdata['set_' + mdataKey][key]) {
            keysToRemove.push(key);
        }
    }

    if (keysToRemove.length) {
        setMdata['remove_' + mdataKey] = keysToRemove;
    }

    return setMdata;
};



/*
 * Creates a remove_metadata object
 */
exports.deleteMetadata = function (mdataKey, key) {
    var setMdata = {};
    setMdata['remove_' + mdataKey] = [key];
    return setMdata;
};



/*
 * Gets all metadata keys from a vm
 */
exports.deleteAllMetadata = function (vm, mdataKey) {
    var setMdata = {};
    var keys = [];

    Object.keys(vm[mdataKey]).forEach(function (key) {
        keys.push(key);
    });

    setMdata['remove_' + mdataKey] = keys;
    return setMdata;
};



/*
 * Converts a list of vms into a hash with key: uuid and value: state
 */
exports.getStatuses = function (vms) {
    var status = {};

    for (var i = 0; i < vms.length; i++) {
        if (vms[i]) {
            status[vms[i].uuid] = vms[i].state;
        }
    }

    return status;
};



/*
 * Generates an array of string that represents the data in the internal
 * metadata object "internalMetadata" in a format that makes it storable in a
 * moray indexed field that makes it searchable.
 *
 * There are a couple of things to keep in mind regarding that conversion:
 *
 * 1. We rely on the guarantee (see http://smartos.org/bugview/PROV-1113) that
 *    internal metadata values are strings, and so there's no need to convert
 *    some values to strings to make them searchable.
 *
 * 2. We intentionally *drop* all strings that are longer than a given threshold
 *    to make them fit under an arbitrary length to avoid storing potentially
 *    huge values (e.g docker:env or docker:cmd data) that would impact Moray
 *    performance negatively. As a result the search facilities provided for
 *    internal metadata is best effort only.
 *
 * 3. We don't store strings that represent objects.
 *
 * @params {Object} internalMetadata (optional): the internal metadata object to
 *   represent as an array of strings.
 *
 * @params {Object} options (required): an object with the following keys:
 *
 *   - log {Object} (required): a bunyan logger instance.
 */
exports.internalMetadataToSearchArray =
function internalMetadataToSearchArray(internalMetadata, options) {
    var log;
    var MAX_METADATA_VALUE_LENGTH = 100;
    var metadataKey;
    var metadataValue;
    var metadataValueType;

    assert.optionalObject(internalMetadata, 'internalMetadata');
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');

    log = options.log;

    /*
     * Using filters on array indexes with null values is not supported in Moray
     * (see https://smartos.org/bugview/MORAY-450), so we manually set the
     * internal_metadata_search_array value to the empty array when the VM
     * object has no internal_metadata value.
     */
    var searchArray = [];

    if (internalMetadata) {
        for (metadataKey in internalMetadata) {
            if (!internalMetadata.hasOwnProperty(metadataKey)) {
                continue;
            }

            metadataValue = internalMetadata[metadataKey];
            metadataValueType = typeof (metadataValue);

            if (metadataValueType === 'string' ||
                metadataValueType === 'number' ||
                metadataValueType === 'boolean') {
                    metadataValue = metadataValue.toString();
            } else {
                /*
                 * We've seen invalid internal_metadata in the wild (see
                 * https://smartos.org/bugview/ZAPI-810), and we don't want to
                 * abort in this case, since it would e.g prevent migrations
                 * from completing, or it would make PutVM(s) requests sent from
                 * e.g vm-agent bring the VMAPI service down. Instead, we output
                 * a warning log entry and we don't write anything in the
                 * internal_metadata_search_array field.
                 */
                log.warn({value: metadataValue, type: metadataValueType},
                    'Invalid internal_metadata value, internal_metadata ' +
                        'values must be of type string, number or boolean');
                continue;
            }

            if (metadataValue.length <= MAX_METADATA_VALUE_LENGTH) {
                searchArray.push(metadataKey + '=' + metadataValue);
            }
        }
    }

    return searchArray;
};