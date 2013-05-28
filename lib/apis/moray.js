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
    this.connected = false;
    this.reconnecting = false;
}

util.inherits(Moray, EventEmitter);



/*
 * Attempts to connect to moray, retrying until connection is established. After
 * connection is established buckets get initialized
 */
Moray.prototype.connect = function (cb) {
    var self = this;
    this.log.debug('Connecting to moray...');

    attemptConnect.call(this, function () {
        self._setupBuckets(function (err) {
            if (!err) {
                self.log.info('Buckets have been loaded');
            }

            // When reconnecting we're not part of async.series
            if (!self.reconnecting) {
                return cb(err);
            }
        });
    });
};



/*
 * Called by Moray.connect. This function will use default retry options for
 * connecting to moray. When connection is ready it will call the callback so
 * connect() can proceed to initialize buckets
 */
function attemptConnect(cb) {
    var log = this.log;
    var retry = this.options.retry || {};
    var self = this;

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

    connection.on('connect', onConnect);
    connection.on('connectAttempt', onConnectAttempt);

    connection.on('close', function () {
        self.connected = false;
        self.reconnecting = true;
        log.error('moray: closed');
    });

    connection.on('error', function (err) {
        self.connected = false;
        log.warn(err, 'moray: error (reconnecting)');
        self.connect(cb);
    });

    function onConnect() {
        log.info({ moray: connection.toString() }, 'moray: connected');
        self.connected = true;
        cb();
    }

    function onConnectAttempt(number, delay) {
        var level;
        if (number === 0) {
            level = 'info';
        } else if (number < 5) {
            level = 'warn';
        } else {
            level = 'error';
        }
        log[level]({
            attempt: number,
            delay: delay
        }, 'moray: connection attempted');
    }
}



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
        vm['owner_uuid'] = hb['owner_uuid'];
        vm['max_physical_memory'] = hb['max_physical_memory'];
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
Moray.prototype.listVms = function listVms(params, cb) {
    var self = this;
    var operation;

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

        var vms = [];
        var req = self.connection.findObjects(VMS_BUCKET_NAME, string, options);

        req.once('error', function (error) {
            return cb(error);
        });

        req.on('record', function (object) {
            if (object && object.value) {
                vms.push(common.translateVm(object.value, true));
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

    vm.state = 'destroyed';
    vm.zone_state = 'destroyed';
    vm.destroyed = new Date();

    self.putVm(vm.uuid, vm, function (err) {
        if (err) {
            callback(err);
        } else {
            callback(null);
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
            var tagString = '*-' + matches[1].replace(/-/g,"%2D") + '=' +
                params[key].replace(/-/g,"%2D") + '-*';
            filter.push(sprintf(PARAM_FILTER, 'tags', tagString));
        }
    });
};



/*
 * Sets up the VM buckets. For now a single vms buckets is used
 */
Moray.prototype._setupBuckets = function (cb) {
    var self = this;

    function onCreateBucket(err) {
        cb(err);
    }

    function onBucket(err, bucket) {
        if (err) {
            if (err.name === 'BucketNotFoundError') {
                self._createBucket(VMS_BUCKET_NAME, VMS_BUCKET, onCreateBucket);
            } else {
                cb(err);
            }
        } else {
            cb(null);
        }
    }

    return this._getBucket(VMS_BUCKET_NAME, onBucket);
    // return this._deleteBucket(VMS_BUCKET_NAME, cb);
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

    if (copy.nics) {
        copy.nics = JSON.stringify(copy.nics);
    }

    if (copy.disks) {
        copy.disks = JSON.stringify(copy.disks);
        // We don't really use it at the top level for KVM, but doing this in
        // moray (and hiding it) allows us to index the image_uuid column and
        // be able to search KVM VMs by image_uuid
        if (copy.disks[0] && copy.disks[0].image_uuid !== undefined) {
            copy.image_uuid = copy.disks[0].image_uuid;
        }
    }

    if (copy.snapshots) {
        copy.snapshots = JSON.stringify(copy.snapshots);
    }

    if (copy.tags && (Object.keys(copy.tags).length > 0)) {
        var tags = common.objectToTagFormat(copy.tags);
        copy.tags = tags;
    } else {
        // Delete empty tags from object
        delete copy.tags;
    }

    if (copy.internal_metadata) {
        copy.internal_metadata = JSON.stringify(copy.internal_metadata);
    }

    if (copy.customer_metadata) {
        copy.customer_metadata = JSON.stringify(copy.customer_metadata);
    }

    return copy;
};


module.exports = Moray;
