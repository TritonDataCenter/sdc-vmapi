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

var errors = require('../errors');
var common = require('./../common');
var moray = require('moray');

var PARAM_FILTER = '(%s=%s)';
var EQ_PARAM_FILTER = '(%s=%s)';
var NE_PARAM_FILTER = '(!(%s=%s))';
var LE_PARAM_FILTER = '(%s<=%s)';
var GE_PARAM_FILTER = '(%s>=%s)';

// Compound
var QUERY_AND = 'and';
var QUERY_OR = 'or';

// Leaf
var QUERY_EQ = 'eq';
var QUERY_NE = 'ne';
var QUERY_LE = 'le';
var QUERY_GE = 'ge';
var LEAFS = [ QUERY_EQ, QUERY_NE, QUERY_LE, QUERY_GE ];

var PARAM_FILTERS = {
    QUERY_EQ: EQ_PARAM_FILTER,
    QUERY_NE: NE_PARAM_FILTER,
    QUERY_LE: LE_PARAM_FILTER,
    QUERY_GE: GE_PARAM_FILTER
};

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
    this.log = options.log;
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
    connection.once('error', onError);
    connection.on('connectAttempt', onConnectAttempt);

    function onConnect() {
        connection.removeListener('error', onError);
        log.info({ moray: connection.toString() }, 'moray: connected');

        connection.on('close', function () {
            self.connected = false;
            self.reconnecting = true;
            log.error('moray: closed');
        });

        connection.on('error', function (err) {
            self.connected = false;
            log.warn(err, 'moray: error (reconnecting)');
        });

        self.connected = true;
        cb();
    }

    function onError(err) {
        self.connected = false;
        log.error(err, 'moray: connection failed');
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
    var sql = 'UPDATE ' + VMS_BUCKET_NAME + ' SET ';

    sql += 'owner_uuid=\'' + hb['owner_uuid'] + '\', ';
    sql += 'max_physical_memory=\'' + hb['max_physical_memory'] + '\', ';
    sql += 'state=\'' + hb.state + '\'';
    sql += ' WHERE uuid=\'' + uuid + '\'';

    this.log.trace({ sql: sql }, 'updateState raw SQL');

    var req = this.connection.sql(sql);

    req.once('error', function (error) {
        return cb(error);
    });

    req.on('record', function (object) {
        // No record
    });

    return req.once('end', function () {
        return cb(null);
    });
};



/*
 * Shared by listVms/countVms
 *
 * It takes same arguments than listVms/countVms do, and will return
 * cb(error, filter), where filter is the search filter based on params.
 */
Moray.prototype._vmsListParams = function _vmsListParams(params, cb) {
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
        filter.push(sprintf(PARAM_FILTER, 'alias', params.alias + '*'));
    }

    if (params.ram || params['max_physical_memory']) {
        var value = params.ram || params['max_physical_memory'];
        filter.push(sprintf(PARAM_FILTER, 'max_physical_memory', value));
    }

    if (params.state) {
        if (params.state === 'active') {
            filter.push('(!(state=destroyed))');
        } else {
            filter.push(sprintf(PARAM_FILTER, 'state', params.state));
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
 * List VMs
 */
Moray.prototype.listVms = function countVms(params, cb) {
    var self = this;
    var operation;

    // if (params.query) {
        // operation = self._filterFromQuery;
    // } else {
        operation = self._vmsListParams;
    // }

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

    return self._vmsListParams(params, function (err, string, sortOptions) {
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
                count = r['_count'];
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
 * Creates a LDAP search query (moray) from a predicate query. Example:
 *
 * {
 *     and: [
 *         { eq: [ "owner_uuid", "00000000-0000-0000-0000-000000000000" ] },
 *         { gt: [ "ram", 128 ] },
 *         { or: [
 *             { eq: [ "alias", "host1" ] },
 *             { eq: [ "alias", "host2" ] }
 *         ] }
 *     ]
 * }
 *
 * Will translate to:
 *
 *  (&(owner_uuid=00000000-0000-0000-0000-000000000000)(ram>128)(|(alias=host1)(alias=host2)))
 *
 */
Moray.prototype._filterFromQuery = function (params, cb) {
    var query = params.query;
    var sortOptions = this._addFilterOptions(params);

    if (typeof (query) !== 'object') {
        error = [ errors.invalidParamErr('query', 'Malformed query') ];
        return cb(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    if (keys.length === 0) {
        return cb(null, '', sortOptions);
    } else if (keys.length > 1) {
        error = [ errors.invalidParamErr('query', 'Malformed query') ];
        return cb(new errors.ValidationFailedError('Invalid Parameters',
            error));
    } else {
        try {
            var string = self._buildFilter(query);
            return cb(null, string, sortOptions);
        } catch (e) {
            return cb(e);
        }
    }
};



/*
 * This is the recursive call to parse the query. Gets called by the above
 * function. Throws an exception when one of the values passed to the query is
 * not a valid parameter
 */
Moray.prototype._buildFilter = function (query) {
    var keys = Object.keys(query);
    var error = [ errors.invalidParamErr('query', 'Malformed query') ];
    var string;

    if (keys.length !== 1) {
        throw new errors.ValidationFailedError('Invalid Parameters', error);
    }

    if (keys[0] == QUERY_AND || keys[0] == QUERY_OR) {
        // 'and' and 'or' describe a list (array) of child conditions
        if (!Array.isArray(query[keys[0]]) || query[keys[0]].length === 0) {
            throw new errors.ValidationFailedError('Invalid Parameters', error);
        }

        string = (keys[0] == QUERY_AND ? '(&' : '(|');
        var i;

        for (i = 0; i < query[keys[0]].length; i++) {
            var newQuery = query[keys[0]][i];
            string += self._buildFilter(newQuery);
        }

        string += ')';

    } else if (LEAFS.indexOf(keys[0]) != -1) {
        // leafs have 2 child conditions: i.e. [ 'ram', 128 ]
        if (!Array.isArray(query[keys[0]]) || query[keys[0]].length !== 2) {
            throw new errors.ValidationFailedError('Invalid Parameters', error);
        }

        // This is where keys will get validated
        string = self._stringForLeaf(keys[0], query[keys[0]]);

    } else {
        var message = 'Unsupported keyword: ' + keys[0];
        var unserror = [ errors.invalidParamErr('query', message) ];
        throw new errors.ValidationFailedError('Invalid Parameters', unserror);
    }

    return string;
};



/*
 * Returns a simple search string depending the operator type. The thing is that
 * this function is the one doing the validation so you don't end up passing
 * invalid parameters to the search query, such as invalid strings for UUIDs, or
 * even pass a non searchable key
 */
Moray.prototype._stringForLeaf = function(op, values) {
    // [ 'ram', 128 ]
    var key = values[0];
    var value = values[1];
    var error;

    if (SEARCHABLE_FIELDS.indexOf(key) == -1) {
        error = [ errors.invalidParamErr(key, 'Non searchable attribute') ];
        throw new errors.ValidationFailedError('Invalid Parameters', error);
    }

    if (key == 'uuid') {
        if (!common.validUUID(value)) {
            error = [ errors.invalidUuidErr('uuid') ];
            throw new errors.ValidationFailedError('Invalid Parameters', error);
        }
    }

    if (key == 'owner_uuid') {
        if (!common.validUUID(value)) {
            error = [ errors.invalidUuidErr('owner_uuid') ];
            throw new errors.ValidationFailedError('Invalid Parameters', error);
        }
    }

    if (key == 'ram') {
        key = 'max_physical_memory';
    }

    if (key == 'state') {
        if (op == 'eq' && value === 'active') {
            op = QUERY_NE;
            value = 'destroyed';
        }
    }

    return sprintf(PARAM_FILTERS[op], key, value);
};



/*
 * Returns an object with sort, limit and offset options for moray
 */
Moray.prototype._addFilterOptions = function(params) {
    var options = {};
    var order = 'DESC';

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
            var tagString = '*-' + matches[1] + '=' + params[key] + '-*';
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
        var isDate = (typeof (copy[key]) === 'object' &&
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
