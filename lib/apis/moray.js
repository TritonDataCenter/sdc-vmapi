/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * Functions for dealing with the Moray datastore.
 */


var EventEmitter = require('events').EventEmitter;
var sprintf = require('sprintf').sprintf;
var assert = require('assert-plus');
var restify = require('restify');
var util = require('util');
var Logger = require('bunyan');
var async = require('async');
var jsprint = require('jsprim');
var ldapjs = require('ldap-filter');

var errors = require('../errors');
var common = require('./../common');
var moray = require('moray');

var SELECT_ALL_FILTER = '(uuid=*)';
var PARAM_FILTER = '(%s=%s)';
var PARAM_FILTER_GE = '(%s>=%s)';
var PARAM_FILTER_LE = '(%s<=%s)';
var PARAM_FILTER_NE = '(!(%s=%s))';

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

// Fields that are deprecated that we're going to remove from VMs as we put
var DEPRECATED_VM_FIELDS = [
    'package_name',
    'package_version'
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
        create_timestamp: { type: 'number' },
        docker: { type: 'boolean' }
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

        connection.on('error', function (err) {
            // not much more to do because the moray client should take
            // care of reconnecting, etc.
            log.error(err, 'moray client error');
        });

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
    } else if (params.uuids) {
        var uuidsFilter = '';

        params.uuids.forEach(function (uuid) {
            uuidsFilter += sprintf(PARAM_FILTER, 'uuid', uuid);
        });

        uuidsFilter = '(|' + uuidsFilter + ')';
        filter.push(uuidsFilter);
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

    if (typeof (params.docker) === 'boolean') {
        var filterStr = params.docker ? PARAM_FILTER : PARAM_FILTER_NE;
        filter.push(sprintf(filterStr, 'docker', true));
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

    if (params.ram || params.max_physical_memory) {
        var value = params.ram || params.max_physical_memory;
        filter.push(sprintf(PARAM_FILTER, 'max_physical_memory', value));
    }

    if (params.state) {
        if (params.state === 'active') {
            filter.push('(&(!(state=destroyed))(!(state=failed)))');
        } else {
            filter.push(sprintf(PARAM_FILTER, 'state', params.state));
        }
    }

    if (params.create_timestamp !== undefined) {
        assert.number(params.create_timestamp,
            'If not undefined, params.create_timestamp must be a number');
        filter.push(sprintf(PARAM_FILTER, 'create_timestamp',
            params.create_timestamp));
    }

    this._addTagsFilter(params, filter);

    return cb(null, filter);
};



/*
 * This is a bit different to getVm.
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
Moray.prototype._parseLdapFilter = function (query, cb) {
    var error;

    if (!query) {
        return cb(null, []);
    }

    if (typeof (query) !== 'string') {
        error = [ errors.invalidParamErr('query', 'Query must be a string') ];
        return cb(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    // TODO additional parsing and validation?
    if (query === '') {
        error = [ errors.invalidParamErr('query', 'Empty query') ];
        return cb(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    query = query.replace(/\(ram/g, '(max_physical_memory');

    return cb(null, [query]);
};



/*
 * Parse a predicate query that allows us to create an ldap filter from an
 * easier syntax/format
 */
Moray.prototype._parsePredicate = function (jsonPredicate, cb) {
    if (!jsonPredicate) {
        return cb(null, []);
    }

    var predicate = JSON.parse(jsonPredicate);
    var query;
    try {
        query = common.toLdapQuery(predicate);
    } catch (error) {
        return cb(error);
    }

    return cb(null, [query]);
};



/*
 * Take all different ways to query listVms/countVms, and create a single
 * LDAP filter to search Moray with.
 */
Moray.prototype._createSearch = function (params, cb) {
    var self = this;

    self._parseLdapFilter(params.query, function (err, ldapSearch) {
        if (err) {
            return cb(err);
        }

        self._parsePredicate(params.predicate, function (err2, predSearch) {
            if (err2) {
                return cb(err2);
            }

            self._vmsListParams(params, function (err3, paraSearch) {
                if (err3) {
                    return cb(err3);
                }

                var filter = [].concat(ldapSearch, predSearch, paraSearch);

                var query;
                if (filter.length === 0) {
                    query = SELECT_ALL_FILTER;
                } else if (filter.length === 1) {
                    query = filter[0];
                } else {
                    query = '(&' + filter.join('') + ')';
                }

                return cb(null, query);
            });
        });
    });
};

/**
 * List all VMs for a given server from the VM bucket.
 * @param  {string}     uuid uuid of the server whos vms should be fetched.
 * @param  {Function}   cb  function of the form function(err, vms) {...}
 */
Moray.prototype.listVmsForServer = function listVmsForServer(uuid, cb) {
    var self = this;
    var vms = {};
    var vm;
    var filter = sprintf(PARAM_FILTER, 'server_uuid', uuid);
    filter += sprintf(PARAM_FILTER_NE, 'state', 'destroyed');
    filter = '(&' + filter + ')';

    var req = self.connection.findObjects(VMS_BUCKET_NAME, filter);

    req.once('error', function (error) {
        return cb(error);
    });

    req.on('record', function (object) {
        if (object && object.value) {
            vm = common.translateVm(object.value, false);
            vms[vm.uuid] = vm;
        }
    });

    return req.once('end', function () {
        return cb(null, vms);
    });
};

/*
 * List VMs
 */
Moray.prototype.listVms = function listVms(params, raw, cb) {
    var self = this;

    // Allow calling listVms with no post-processing of the VM object
    if (typeof (raw) === 'function') {
        cb = raw;
        raw = false;
    }

    self._createSearch(params, function (err, ldapFilter) {
        if (err) {
            return cb(err);
        }

        self.log.info({ filter: ldapFilter }, 'listVms filter');

        var vm;
        var vms = [];
        var filterOptions = _addPaginationOptions(params, ldapFilter);
        var req = self.connection.findObjects(VMS_BUCKET_NAME,
            filterOptions.ldapFilter, filterOptions.morayOptions);

        req.once('error', function (error) {
            return cb(error);
        });

        req.on('record', function (object) {
            if (object && object.value) {
                vm  = (raw ? object.value
                           : common.translateVm(object.value, true));
                // The way the API works wrt markers is that the client
                // requests the first page of results. Then to get the second
                // page of results, the client adds a marker to the query
                // string. This marker identifies the last entry of the first
                // page. Thus, if a marker is used, do not include the VM that
                // corresponds to that marker in the results of a given page,
                // as the client already got it with the previous page.
                if (!params.marker ||
                    !common.markerIdentifiesObject(params.marker, vm)) {
                    vms.push(vm);
                }
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

    self._createSearch(params, function (err, string) {
        if (err) {
            return cb(err);
        }

        var options = {
            limit: 1
        };

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
 * Deletes *all* VMs that match the filter generated from "params".
 * This API is INTERNAL and should ONLY BE USED FOR WRITING TESTS.
 */
Moray.prototype.delVms = function delVms(params, cb) {
    assert.object(params, 'params');
    assert.func(cb, 'cb');

    var self = this;
    self._createSearch(params, function (err, filter) {
        if (err) {
            return cb(err);
        }

        // Make sure that the filter is not the filter that selects all VMs.
        // We don't want to allow deletion of all VMs via this API.
        assert.notEqual(filter, SELECT_ALL_FILTER);
        return self.connection.deleteMany(VMS_BUCKET_NAME, filter, params, cb);
    });
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
 * Returns a list of objects each representing a sort option to pass
 * to moray according to the sort parameter "sortparam" that was passed
 * by the HTTP client.
 * If no sort option needs to be set, an empty array is returned.
 */
function _sortOptionsFromSortParam(sortParam) {
    assert.optionalString(sortParam, 'sortParam must be a string or undefined');

    var sortOptions = [];
    var order;

    if (sortParam) {
        var splitted = sortParam.split('.');
        var property = splitted[0];

        if (property == 'ram') {
            property = 'max_physical_memory';
        }

        if (splitted.length == 2) {
            order = splitted[1] || common.DEFAULT_SORT_ORDER;
        }

        sortOptions.push({
            attribute: property,
            order: order
        });
    }

    // If the sorting options will not output a totally ordered results set,
    // add a sort option that will. This makes the last item of any
    // results set (even when not using a marker, for example when getting
    // the first page of paginated results) usable as a marker for getting
    // the next page of paginated results.
    var sortOptionsHasStrictTotalOrder =
        sortOptions.some(function (sortOption) {
            return common.isStrictTotalOrderField(sortOption.attribute);
        });

    if (!sortOptionsHasStrictTotalOrder) {
        sortOptions.push({
            attribute: common.strictTotalOrderField(),
            order: common.DEFAULT_SORT_ORDER
        });
    }

    return sortOptions;
}

/*
 * Build the appropriate LDAP filters for the marker "marker" and the sort
 * options "sortOptions". Returns a list of strings representing ldap
 * filters. An empty list is returned if a filter is not required for the
 * corresponding marker and sortOptions.
 */
function _buildFiltersFromMarker(marker, sortOptions) {
    assert.object(marker, 'marker must be an object');
    assert.arrayOfObject(sortOptions,
        'sortOptions must be an array of objects');

    var markerFilters = [];

    var sortOptionsLookup = {};
    sortOptions.forEach(function (sortOption) {
        assert.string(sortOption.attribute,
            'sortOption.attribute must be a string');
        assert.string(sortOption.order,
            'sortOption.order must be a string');

        sortOptionsLookup[sortOption.attribute] = sortOption.order;
    });

    Object.keys(marker).forEach(function (markerKey) {
        var markerValue = '' + marker[markerKey];
        var order;
        var ldapFilter;

        if (markerValue !== null) {
            order = sortOptionsLookup[markerKey];
            if (order === undefined)
                order = common.DEFAULT_SORT_ORDER;

            if (common.isSortOrderDescending(order)) {
                ldapFilter = new ldapjs.LessThanEqualsFilter({
                    attribute: markerKey,
                    value: markerValue
                });
            } else {
                ldapFilter = new ldapjs.GreaterThanEqualsFilter({
                    attribute: markerKey,
                    value: markerValue
                });
            }

            markerFilters.push(ldapFilter);
        }
    });

    return markerFilters;
}

/*
 * Augments moray params and ldapFilter used to query moray with
 * relevant moray options and ldap filter according to pagination options.
 *
 * Returns an object with two sub-objects:
 * - morayOptions: an object that contains sort, limit and offset options for
 * moray.
 * - ldapFilter: a string that contains the ldapFilter corresponding to the
 * original ldap filter + the additional filters to handle pagination when
 * using the "marker" querystring parameter.
 */
function _addPaginationOptions(params, ldapFilterString) {
    assert.object(params, 'params must be an object');
    assert.string(ldapFilterString, 'ldapFilter must be a string');

    var sortOptions = _sortOptionsFromSortParam(params.sort);

    var markerFilters, ldapFilterObject, combinedFilters;

    var morayOptions = {
        limit: params.limit,
        offset: params.offset
    };

    var paginationOptionsOut = {
        ldapFilter: ldapFilterString,
        morayOptions: morayOptions
    };

    morayOptions.sort = sortOptions;

    // If a marker is used, the entry corresponding to that marker must not
    // be returned in the result, but will be included in the filter, so
    // increment the limit to get the correct number of entries once the
    // entry that corresponds to the marker is removed
    if (morayOptions.limit !== undefined && params.marker) {
        morayOptions.limit += 1;
    }

    if (params.marker) {
        markerFilters = _buildFiltersFromMarker(params.marker, sortOptions);
        ldapFilterObject = ldapjs.parse(ldapFilterString);
        assert.object(ldapFilterObject, 'ldapFilterObject must be an object');

        combinedFilters = [ldapFilterObject].concat(markerFilters);
        paginationOptionsOut.ldapFilter = new ldapjs.AndFilter({
            filters: combinedFilters
        }).toString();
    }

    return paginationOptionsOut;
}

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
    var idx;

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

    // Remove deprecated fields
    for (idx = 0; idx < DEPRECATED_VM_FIELDS.length; idx++) {
        delete copy[DEPRECATED_VM_FIELDS[idx]];
    }

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
 * VM Role Tags
 */


/*
 * Get all VM role_tags that match one or more role_tags. Returns a list of
 * VM UUIDs.
 */
Moray.prototype.getRoleTags = function (roleTags, cb) {
    var filter = '';

    roleTags.forEach(function (roleTag) {
        filter += sprintf(PARAM_FILTER, 'role_tags', roleTag);
    });

    filter = '(|' + filter + ')';
    var uuids = [];
    var req = this.connection.findObjects(VM_ROLE_TAGS_BUCKET_NAME, filter);

    req.once('error', function (err) {
        return cb(err);
    });

    req.on('record', function (object) {
        uuids.push(object.key);
    });

    req.once('end', function () {
        return cb(null, uuids);
    });
};


/*
 * Get all role_tags for a VM
 */
Moray.prototype.getVmRoleTags = function (uuid, cb) {
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
Moray.prototype.putVmRoleTags = function (uuid, roleTags, cb) {
    var object = { role_tags: roleTags };
    this.connection.putObject(VM_ROLE_TAGS_BUCKET_NAME, uuid, object, cb);
};


/*
 * Deletes all role_tags for a VM
 */
Moray.prototype.delVmRoleTags = function (uuid, cb) {
    this.connection.delObject(VM_ROLE_TAGS_BUCKET_NAME, uuid, function (err) {
        if (!err || (err && err.name === 'ObjectNotFoundError')) {
            cb(null);
        } else {
            cb(err);
        }
    });
};

module.exports = Moray;
