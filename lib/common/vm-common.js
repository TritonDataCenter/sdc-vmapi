/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var assert = require('assert');
var restify = require('restify');
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
        if (typeof (obj.customer_metadata) == 'string')
            obj.customer_metadata = JSON.parse(obj.customer_metadata);
    } catch (e) {}

    try {
        if (typeof (obj.internal_metadata) == 'string')
            obj.internal_metadata = JSON.parse(obj.internal_metadata);
    } catch (e) {}


    // Single tag case OR when reading from redis cache
    if (typeof (obj.tags) === 'string') {
        try {
            obj.tags = JSON.parse(obj.tags);
        } catch (e) {
            obj.tags = [obj.tags];
        }
    }

    if (Array.isArray(obj.tags)) {
        obj.tags = keyValueToObject(obj.tags);
    }

    function dateFromInput(input) {
        return (isNaN(Number(input))
             ? new Date(input)
             : new Date(Number(input)));
     }

    var timestamps = ['create_timestamp', 'last_modified', 'destroyed' ];
    timestamps.forEach(function (key) {
        if (obj[key]) {
            obj[key] = dateFromInput(obj[key]);
        }
    });

    var vm = {
        uuid: obj.uuid,
        brand: obj.brand,
        dataset_uuid: obj.image_uuid, // DEPRECATED
        image_uuid: obj.image_uuid,
        server_uuid: obj.server_uuid,
        billing_id: obj.billing_id,
        package_name: obj.package_name,
        package_version: obj.package_version,
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
        owner_uuid: vmOwner(obj.dn) || obj.owner_uuid,
        nics: obj.nics,
        customer_metadata: obj.customer_metadata,
        internal_metadata: obj.internal_metadata,
        tags: obj.tags
    };

    if (fullObject) {
        if (vm.ram === undefined && vm.max_physical_memory !== undefined) {
            vm.ram = vm.max_physical_memory;
        }

        Object.keys(vm).forEach(function (key) {
            if (vm[key] === undefined) {
                var value;
                if (key == 'customer_metadata' || key == 'internal_metadata' ||
                    key == 'tags') {
                    value = {};
                } else if (key == 'nics') {
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
    'napi_username',
    'napi_password',
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



/*
 * Converts a key=value to a javascript literal
 *
 * foo=bar
 * => { foo: 'bar' }
 */
function keyValueToObject(array) {
    if (!array || !Array.isArray(array)) {
        throw new TypeError('Array of key/values required');
    }

    var obj = {};

    array.forEach(function (keyvalue) {
        var kv = keyvalue.split('=');

        if (kv.length != 2) {
            throw new TypeError('Key/value string expected');
        }

        obj[kv[0]] = kv[1];
    });

    return obj;
}

exports.keyValueToObject = keyValueToObject;



/*
 * Converts a javascript literal to a key=value. The literal is expected to have
 * simple string/numeric values for its properties.
 *
 * { foo: 'bar' }
 * => foo=bar
 */
function objectToKeyValue(obj) {
    if (!obj || typeof (obj) !== 'object') {
        throw new TypeError('Object required');
    }

    var values = [];

    Object.keys(obj).forEach(function (key) {
        var value = key + '=' + obj[key];
        values.push(value);
    });

    return values;
}

exports.objectToKeyValue = objectToKeyValue;



/*
 * Stringifies keys to store in the Redis cache
 */
exports.vmToHash = function (vm) {
    var copy = clone(vm);

    delete copy.dataset_uuid;

    if (copy.nics) {
        copy.nics = JSON.stringify(copy.nics);
    }

    if (copy.tags) {
        copy.tags = JSON.stringify(copy.tags);
    }

    if (copy.internal_metadata) {
        copy.internal_metadata = JSON.stringify(copy.internal_metadata);
    }

    if (copy.customer_metadata) {
        copy.customer_metadata = JSON.stringify(copy.customer_metadata);
    }

    return copy;
};



/*
 * Creates a set_metada object
 */
exports.addMetadata = function (mdataKey, params) {
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
        throw new restify.InvalidArgumentError('At least one ' + mdataKey +
          ' key must be provided');
    }

    // This will give you something like this:
    // { set_customer_metadata: { foo: 'bar' } }
    setMdata['set_' + mdataKey] = mdata;
    return setMdata;
};



/*
 * Creates a set_metada object that replaces current metadata
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
 * Parses tag.xxx=yyy from the request params
 *   a="tag.role"
 *   m=a.match(/tag\.(.*)/)
 *   [ 'tag.role',
 *     'role',
 *     index: 0,
 *     input: 'tag.role' ]
 */
exports.addTagsFilter = function (params, filter) {
    Object.keys(params).forEach(function (key) {
        var matches = key.match(/tag\.(.*)/);
        if (matches) {
            var tag = matches[1];
            filter += '(tags=' + tag + '=' + params[key] + ')';
        }
    });

    return filter;
};



/*
 * Converts a list of vms into a hash with key: uuid and value: state
 */
exports.getStatuses = function (vms) {
    var status = {};

    for (var i = 0; i < vms.length; i++) {
        if (vms[i])
            status[vms[i].uuid] = vms[i].state;
    }

    return status;
};
