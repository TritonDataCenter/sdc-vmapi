/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var EventEmitter = require('events').EventEmitter;
var sprintf = require('sprintf').sprintf;
var assert = require('assert');
var restify = require('restify');
var util = require('util');
var Logger = require('bunyan');
var async = require('async');

var errors = require('../errors');
var common = require('./../common');
var moray = require('moray');

var PARAM_FILTER = '(%s=%s)';


// Only indexed columns can be searched
var SEARCHABLE_FIELDS = [
    'uuid',
    'owner_uuid',
    'image_uuid',
    'billing_id',
    'server_uuid',
    'package_name',
    'package_version',
    'brand',
    'state',
    'alias',
    'max_physical_memory',
    'ram',
    'create_timestamp'
];

/*
 * Basically the VMs table
 */
var VMS_BUCKET_NAME = 'vmapi_vms';
var VMS_BUCKET = {
    index: {
        uuid: { type: 'string', unique: true},
        owner_uuid: { type: 'string' },
        image_uuid: { type: 'string' },
        billing_id: { type: 'string' },
        server_uuid: { type: 'string' },
        package_name: { type: 'string' },
        package_version: { type: 'string' },
        tags: { type: 'string' },
        brand: { type: 'string' },
        state: { type: 'string' },
        alias: { type: 'string' },
        max_physical_memory: { type: 'number' },
        create_timestamp: { type: 'number' }
    }
};


/*
 * This table allows us to keep track of VMs on a server so VMAPI
 * can detect if a VM has been destroyed
 */
var SERVER_VMS_BUCKET_NAME = 'vmapi_server_vms';
var SERVER_VMS_BUCKET = {};


/*
 * This table allows us to store role_tags for VMs
 */
var VM_ROLE_TAGS_BUCKET_NAME = 'vmapi_vm_role_tags';
var VM_ROLE_TAGS_BUCKET = {
    index: {
        role_tags: { type: '[string]' }
    }
};


/*
 * Moray constructor
 */
function Moray(options) {
    EventEmitter.call(this);
    // this.log = options.log;
    // this.log.level(options.logLevel || 'info');
    this.log = new Logger({
        name: 'moray',
        level: options.logLevel || 'info',
        serializers: restify.bunyan.serializers
    });
    this.options = options;
}

util.inherits(Moray, EventEmitter);



/*
 * Attempts to connect to moray, retrying until connection is established. After
 * connection is established buckets get initialized
 */
Moray.prototype.connect = function () {
    var self = this;
    var log = this.log;
    var retry = this.options.retry || {};
    this.log.debug('Connecting to moray...');

    var connection = this.connection = moray.createClient({
        connectTimeout: this.options.connectTimeout || 200,
        log: this.log,
        host: this.options.host,
        port: this.options.port,
        reconnect: true,
        retry: (this.options.retry === false ? false : {
            retries: Infinity,
            minTimeout: retry.minTimeout || 1000,
            maxTimeout: retry.maxTimeout || 16000
        })
    });

    connection.on('connect', function () {
        log.info({ moray: connection.toString() }, 'moray: connected');
        self.emit('moray-connected');

        self._setupBuckets(function (err) {
            if (err) {
                self.log.error({ err: err }, 'Buckets were not loaded');
            } else {
                self.emit('moray-ready');
                self.log.info('Buckets have been loaded');
            }
        });
    });
};



/*
 * Pings Moray by calling its ping method
 */
Moray.prototype.ping = function (callback) {
    // Default ping timeout is 1 second
    return this.connection.ping({ log: this.log }, callback);
};



/*
 * Gets a VM object from moray. uuid is required param and owner_uuid is
 * optional
 */
Moray.prototype.getVm = function (params, cb) {
    var uuid = params.uuid;
    var owner = params.owner_uuid;
    var filter = '';
    var error;

    if (!common.validUUID(uuid)) {
        error = [ errors.invalidUuidErr('uuid') ];
        return cb(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    filter += sprintf(PARAM_FILTER, 'uuid', uuid);

    if (owner) {
        if (!common.validUUID(owner)) {
            error = [ errors.invalidUuidErr('owner_uuid') ];
            return cb(new errors.ValidationFailedError('Invalid Parameters',
                error));
        }

        filter += sprintf(PARAM_FILTER, 'owner_uuid', owner);
        filter = '(&' + filter + ')';
    }

    var vm;
    var req = this.connection.findObjects(VMS_BUCKET_NAME, filter);

    req.once('error', function (err) {
        return cb(err);
    });

    // For getVm we want the first result (and there should only be one result)
    req.once('record', function (object) {
        vm = object.value;
    });

    return req.once('end', function () {
        return cb(null, vm);
    });
};



/*
 * Gets VMs from a list of UUIDs
 */
Moray.prototype.getVms = function (uuids, cb) {
    var filter = '';
    var i;

    for (i = 0; i < uuids.length; i++) {
        filter += sprintf(PARAM_FILTER, 'uuid', uuids[i]);
    }

    filter = '(|' + filter + ')';
    var vms = [];
    var req = this.connection.findObjects(VMS_BUCKET_NAME, filter);

    req.once('error', function (err) {
        return cb(err);
    });

    req.on('record', function (object) {
        vms.push(common.translateVm(object.value, true));
    });

    req.once('end', function () {
        return cb(null, vms);
    });
};



/*
 * Updates the zone_state, state and last_modified values of a VM without having
 * to call putObject(). Here we execute sql code directly
 */
Moray.prototype.updateState = function (uuid, hb, cb) {
    var self = this;
    self._getVmObject(uuid, onObject);

    function onObject(err, obj) {
        if (err) {
            cb(err);
            return;
        }

        var vm = common.translateVm(obj, false);

        // Some heartbeats might not have this information
        if (hb['owner_uuid']) {
            vm['owner_uuid'] = hb['owner_uuid'];
        }
        if (hb['max_physical_memory']) {
            vm['max_physical_memory'] = hb['max_physical_memory'];
        }
        vm['state'] = hb['state'];
        vm['zone_state'] = hb['zone_state'];

        // Only preemptively set last_modified for a new VM
        if (obj['last_modified'] === undefined) {
            vm['last_modified'] = new Date(hb['last_modified']).getTime();
        }

        self.putVm(uuid, vm, cb);
    }
};



/*
 * Shared by listVms/countVms
 *
 * It takes same arguments than listVms/countVms do, and will return
 * cb(error, filter), where filter is the search filter based on params.
 */
Moray.prototype._vmsListParams = function (params, cb) {
    var filter = [];
    var error;

    if (params.uuid) {
        if (!common.validUUID(params.uuid)) {
            error = [ errors.invalidUuidErr('uuid') ];
            return cb(new errors.ValidationFailedError('Invalid Parameters',
                error));
        }
        filter.push(sprintf(PARAM_FILTER, 'uuid', params.uuid));
    }

    if (params.owner_uuid) {
        if (!common.validUUID(params.owner_uuid)) {
            error = [ errors.invalidUuidErr('owner_uuid') ];
            return cb(new errors.ValidationFailedError('Invalid Parameters',
                error));
        }
        filter.push(sprintf(PARAM_FILTER, 'owner_uuid', params.owner_uuid));
    }

    if (params.image_uuid) {
        filter.push(sprintf(PARAM_FILTER, 'image_uuid', params.image_uuid));
    }

    if (params.server_uuid) {
        filter.push(sprintf(PARAM_FILTER, 'server_uuid', params.server_uuid));
    }

    if (params.billing_id) {
        filter.push(sprintf(PARAM_FILTER, 'billing_id', params.billing_id));
    }

    if (params.package_name) {
        filter.push(sprintf(PARAM_FILTER, 'package_name', params.package_name));
    }

    if (params.package_version) {
        filter.push(sprintf(
                    PARAM_FILTER, 'package_version', params.package_version));
    }

    if (params.brand) {
        filter.push(sprintf(PARAM_FILTER, 'brand', params.brand));
    }

    if (params.alias) {
        var str;
        // When doing an update we don't want to use a wildcard match
        if (params._update) {
            str = sprintf(PARAM_FILTER, 'alias', params.alias);
        } else {
            str = sprintf(PARAM_FILTER, 'alias', params.alias + '*');
        }
        filter.push(str);
    }

    if (params.ram || params['max_physical_memory']) {
        var value = params.ram || params['max_physical_memory'];
        filter.push(sprintf(PARAM_FILTER, 'max_physical_memory', value));
    }

    if (params.state) {
        if (params.state === 'active') {
            filter.push('(&(!(state=destroyed))(!(state=failed)))');
        } else {
            filter.push(sprintf(PARAM_FILTER, 'state', params.state));
        }
    }

    if (params.create_timestamp) {
        var ts = params.create_timestamp;
        var input = isNaN(Number(ts)) ? ts : Number(ts);
        var tts = new Date(input).getTime();
        if (!isNaN(tts)) {
            filter.push(sprintf(PARAM_FILTER, 'create_timestamp', tts));
        }
    }

    this._addTagsFilter(params, filter);
    var sortOptions = this._addFilterOptions(params);
    var string = filter.join('');

    if (filter.length === 0) {
        string = '(uuid=*)';
    } else if (filter.length > 1) {
        string = '(&' + string + ')';
    }

    return cb(null, string, sortOptions);
};



/*
 * This is a bit different to getVm. We use this one from the heartbeater and
 * call getObject instead of findObjects because getVm can use a search filter.
 * For this one we need exactly the VM that has the provided UUID
 */
Moray.prototype._getVmObject = function (uuid, cb) {
    this.connection.getObject(VMS_BUCKET_NAME, uuid, function (err, obj) {
        if (err) {
            cb(err);
        } else {
            cb(null, obj.value);
        }
    });
};



/*
 * Raw LDAP search filter
 */
Moray.prototype._parseLdapFilter = function (params, cb) {
    var error;

    if (typeof (params.query) !== 'string') {
        error = [ errors.invalidParamErr('query', 'Query must be a string') ];
        return cb(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    // TODO additional parsing and validation?
    if (params.query === '') {
        error = [ errors.invalidParamErr('query', 'Empty query') ];
        return cb(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    params.query = params.query.replace(/\(ram/g, '(max_physical_memory');

    var sortOptions = this._addFilterOptions(params);
    return cb(null, params.query, sortOptions);
};



/*
 * List VMs
 */
Moray.prototype.listVms = function listVms(params, raw, cb) {
    var self = this;
    var operation;

    // Allow calling listVms with no post-processing of the VM object
    if (typeof (raw) === 'function') {
        cb = raw;
        raw = false;
    }

    if (params.query) {
        operation = self._parseLdapFilter;
    } else {
        operation = self._vmsListParams;
    }

    return operation.call(self, params, function (err, string, options) {
        if (err) {
            return cb(err);
        }

        if (string === '') {
            string = '(uuid=*)';
        }

        self.log.info({ filter: string }, 'listVms filter');

        var vm;
        var vms = [];
        var req = self.connection.findObjects(VMS_BUCKET_NAME, string, options);

        req.once('error', function (error) {
            return cb(error);
        });

        req.on('record', function (object) {
            if (object && object.value) {
                vm  = (raw ? object.value
                           : common.translateVm(object.value, true));
                vms.push(vm);
            }
        });

        return req.once('end', function () {
            return cb(null, vms);
        });
    });
};



/*
 * Given the same filter listVms uses, this function transforms it into
 * something which can be send to moray through RAW sql method.
 *
 * This method will return the number of total machines matching the given
 * params conditions using the traditional cb(err, counter) approach.
 */
Moray.prototype.countVms = function countVms(params, cb) {
    var self = this;
    var operation;

    if (params.query) {
        operation = self._parseLdapFilter;
    } else {
        operation = self._vmsListParams;
    }

    return operation.call(self, params, function (err, string, sortOptions) {
        if (err) {
            return cb(err);
        }

        var options = {
            limit: 1
        };

        if (string === '') {
            string = '(uuid=*)';
        }

        self.log.info({ filter: string }, 'countVms filter');
        var req = self.connection.findObjects(VMS_BUCKET_NAME, string, options);
        var count = 0;

        req.on('record', function (r) {
            if (r && r['_count']) {
                count = Number(r['_count']);
            }
        });

        req.once('error', function (error) {
            return cb(error);
        });

        return req.once('end', function () {
            return cb(null, count);
        });
    });
};



/*
 * Puts a VM. If it doesn't exist it gets created, if it does exist it gets
 * updated. We no longer need to execute partial updates
 */
Moray.prototype.putVm = function (uuid, vm, cb) {
    var object = this._toMorayVm(vm);
    this.connection.putObject(VMS_BUCKET_NAME, uuid, object, cb);
};




/*
 * Marks a VM as destroyed
 */
Moray.prototype.markAsDestroyed = function (vm, callback) {
    var self = this;

    var state = (vm.state === 'provisioning') ? 'failed' : 'destroyed';

    vm.state = state;
    vm.zone_state = state;
    if (state === 'destroyed') {
        vm.destroyed = new Date();
    }

    self.putVm(vm.uuid, vm, function (err) {
        if (err) {
            callback(err);
        } else {
            callback(null, vm);
        }
    });
};



/*
 * Returns an object with sort, limit and offset options for moray
 */
Moray.prototype._addFilterOptions = function (params) {
    var options = {};
    var order;
    var defaultOrder = 'DESC';

    if (params.sort) {
        var splitted = params.sort.split('.');
        var property = splitted[0];

        if (property == 'ram') {
            property = 'max_physical_memory';
        }

        if (splitted.length == 2) {
            order = splitted[1] || defaultOrder;
        }

        options.sort = {
            attribute: property,
            order: order
        };
    } else {
        options.sort = {
            attribute: '_id',
            order: 'ASC'
        };
    }

    if (params.offset) {
        options.offset = params.offset;
    }

    if (params.limit) {
        options.limit = params.limit;
    }

    return options;
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
Moray.prototype._addTagsFilter = function (params, filter) {
    Object.keys(params).forEach(function (key) {
        var matches = key.match(/tag\.(.*)/);
        if (matches) {
            var tagKey = matches[1].replace(/-/g, '%2D');
            var tagString;
            var value = params[key];

            // Numbers have to be backwards compatible if VMs with numbers as
            // key values already exist
            if (value === 'true' || value === 'false') {
                var bool = '*-' + tagKey + '=' + '%b{' + value + '}' + '-*';
                tagString = '*-' + tagKey + '=' + value + '-*';
                filter.push(sprintf('(|(tags=%s)(tags=%s))', bool, tagString));

            } else if (!isNaN(Number(value))) {
                var num = '*-' + tagKey + '=' + '%n{' + value + '}' + '-*';
                tagString = '*-' + tagKey + '=' + value + '-*';
                filter.push(sprintf('(|(tags=%s)(tags=%s))', num, tagString));

            } else {
                value = value.replace(/-/g, '%2D');
                tagString = '*-' + tagKey + '=' + value + '-*';
                filter.push(sprintf(PARAM_FILTER, 'tags', tagString));
            }
        }
    });
};



/*
 * Sets up the VMAPI buckets.
 */
Moray.prototype._setupBuckets = function (cb) {
    var self = this;
    var buckets = [ {
        name: VMS_BUCKET_NAME,
        indices: VMS_BUCKET
    }, {
        name: SERVER_VMS_BUCKET_NAME,
        indices: SERVER_VMS_BUCKET
    }, {
        name: VM_ROLE_TAGS_BUCKET_NAME,
        indices: VM_ROLE_TAGS_BUCKET
    } ];

    async.mapSeries(buckets, function (bucket, next) {
        self._getBucket(bucket.name, function (err, bck) {
            if (err) {
                if (err.name === 'BucketNotFoundError') {
                    self._createBucket(bucket.name, bucket.indices, next);
                } else {
                    next(err);
                }
            } else {
                next(null);
            }
        });
    }, function (err) {
        cb(err);
    });
};



/*
 * Gets a bucket
 */
Moray.prototype._getBucket = function (name, cb) {
    this.connection.getBucket(name, cb);
};



/*
 * Creates a bucket
 */
Moray.prototype._createBucket = function (name, config, cb) {
    this.connection.createBucket(name, config, cb);
};



/*
 * Deletes a bucket
 */
Moray.prototype._deleteBucket = function (name, cb) {
    this.connection.delBucket(name, cb);
};



/*
 * Converts to a valid moray VM object
 */
Moray.prototype._toMorayVm = function (vm) {
    var copy = common.clone(vm);

    var timestamps = ['create_timestamp', 'last_modified', 'destroyed' ];
    timestamps.forEach(function (key) {
        var isDate = (copy[key] !== null && typeof (copy[key]) === 'object' &&
            copy[key].getMonth !== undefined);

        if (typeof (copy[key]) === 'string') {
            copy[key] = new Date(copy[key]).getTime();
        } else if (isDate) {
            copy[key] = copy[key].getTime();
        }
    });

    // Only stringify if they are object
    var fields = ['nics', 'datasets', 'snapshots', 'internal_metadata',
        'customer_metadata'];
    fields.forEach(function (key) {
        if (copy[key] && typeof (copy[key]) === 'object') {
            copy[key] = JSON.stringify(copy[key]);
        }
    });

    if (copy.disks && typeof (copy.disks) === 'object') {
        // We don't really use it at the top level for KVM, but doing this in
        // moray (and hiding it) allows us to index the image_uuid column and
        // be able to search KVM VMs by image_uuid
        if (copy.disks[0] && copy.disks[0].image_uuid !== undefined) {
            copy.image_uuid = copy.disks[0].image_uuid;
        }
        copy.disks = JSON.stringify(copy.disks);
    }

    if (copy.tags && typeof (copy.tags) === 'object') {
        if ((Object.keys(copy.tags).length > 0)) {
            var tags = common.objectToTagFormat(copy.tags);
            copy.tags = tags;
        // Don't want to store '{}'
        } else {
            delete copy.tags;
        }
    }

    return copy;
};



/**
 * Moray cache functions. There is a separate bucket where we track state
 * of current VM states so VMAPI can decide when VMs have changed state.
 */

/*
 * Gets a list of VMs that live on a server
 */
Moray.prototype.getVmsForServer = function (server, cb) {
    this.connection.getObject(SERVER_VMS_BUCKET_NAME, server,
      function (err, obj) {
        if (err) {
            // First time a heartbeat is received from a server
            if (err.name === 'ObjectNotFoundError') {
                cb(null, []);
            } else {
                cb(err);
            }
        } else {
            cb(null, Object.keys(obj.value));
        }
    });
};



/*
 * Sets a list of VMs that live on a server
 */
Moray.prototype.setVmsForServer = function (server, hash, cb) {
    var self = this;

    // If the server has no VMs anymore, delete its entry from cache
    if (Object.keys(hash).length === 0) {
        // Check if server record exists, we can't call delObject on servers
        // that don't exist in moray yet.
        this.connection.getObject(SERVER_VMS_BUCKET_NAME, server,
          function (err, obj) {
            if (err) {
                if (err.name === 'ObjectNotFoundError') {
                    cb(null);
                } else {
                    cb(err);
                }
            } else {
                self.connection.delObject(SERVER_VMS_BUCKET_NAME, server,
                    onOperation);
            }
        });

    } else {
        this.connection.putObject(SERVER_VMS_BUCKET_NAME, server, hash,
            onOperation);
    }

    function onOperation(err) {
        if (err) {
            cb(err);
        } else {
            cb(null);
        }
    }
};



/*
 * Gets the status stamp for a VM. The stamp format has the following form:
 *
 * $zone_state;$last_modified;$server
 *
 */
Moray.prototype.getState = function (uuid, cb) {
    this._getVmObject(uuid, function onObject(err, obj) {
        if (err) {
            cb(err);
        } else {
            var stateTs;
            // Provisioning VMs don't have an existing cache state, stateTs
            // will be undefined for them
            if (obj['last_modified'] === undefined) {
                /*jsl:pass*/
                // cb(null, stateTs);
            } else if (obj['server_uuid'] === undefined) {
                stateTs = obj.state + ';' + obj['last_modified'];
            } else {
                stateTs = obj.state + ';' + obj['last_modified'] + ';' +
                    obj['server_uuid'];
            }

            cb(null, stateTs);
        }
    });
};



/*
 * Sets the state stamp for a VM. On a moray cache this is not needed because
 * we already persisted the VM state with either updateStateOnMoray or
 * updateVmOnMoray. In order to not break the interface we just call cb();
 */
Moray.prototype.setState = function (uuid, hb, server, cb) {
    return cb(null);
};



/*
 * Deletes the state stamp for a VM. Called after markAsDestroyed. On a moray
 * cache this is not needed because we already persisted the VM state as
 * destroyed with markAsDestroyed. In order to not break the interface we just
 * call cb();
 */
Moray.prototype.delState = function (uuid, cb) {
    return cb(null);
};



/**
 * VM Role Tags
 */


/*
 * Get all role_tags for a VM
 */
Moray.prototype.getRoleTags = function (uuid, cb) {
    this.connection.getObject(VM_ROLE_TAGS_BUCKET_NAME, uuid,
        function (err, obj) {
        if (err) {
            if (err.name === 'ObjectNotFoundError') {
                cb(null, []);
            } else {
                cb(err);
            }
        } else {
            cb(null, obj.value.role_tags);
        }
    });
};


/*
 * Puts a new role_tags object
 */
Moray.prototype.putRoleTags = function (uuid, roleTags, cb) {
    var object = { role_tags: roleTags };
    this.connection.putObject(VM_ROLE_TAGS_BUCKET_NAME, uuid, object, cb);
};


/*
 * Deletes all role_tags for a VM
 */
Moray.prototype.delRoleTags = function (uuid, cb) {
    this.connection.delObject(VM_ROLE_TAGS_BUCKET_NAME, uuid, function (err) {
        if (!err || (err && err.name === 'ObjectNotFoundError')) {
            cb(null);
        } else {
            cb(err);
        }
    });
};

module.exports = Moray;
