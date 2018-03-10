/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * This module implements a "Moray" class that can be used to create
 * objects that act as an abstraction layer on top of the moray key/value store
 * used to store data about VMs.
 *
 * Instead of directly using a moray client and having to know the
 * implementation details about how VMAPI objects are stored, one can use
 * instances of the Moray class and use a simpler API that handles these
 * implementation details when reading and writing VMAPI objects to the moray
 * database.
 *
 * VMAPI uses one instance of Moray, and so most of the time it is used
 * as a singleton, even though any number instances of the Moray
 * class can be created.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var deepDiff = require('deep-diff');
var jsprim = require('jsprim');
var ldapjs = require('ldap-filter');
var once = require('once');
var restify = require('restify');
var sprintf = require('sprintf').sprintf;
var strsplit = require('strsplit');
var util = require('util');
var vasync = require('vasync');
var verror = require('verror');

var errors = require('../errors');
var common = require('../common');

// Fields that are deprecated that we're going to remove from VMs as we put
var DEPRECATED_VM_FIELDS = [
    'package_name',
    'package_version'
];
var PARAM_FILTER = '(%s=%s)';
var PARAM_FILTER_GE = '(%s>=%s)';
var PARAM_FILTER_LE = '(%s<=%s)';
var PARAM_FILTER_NE = '(!(%s=%s))';
var SELECT_ALL_FILTER = '(uuid=*)';
var VM_OBJECTS_DATA_VERSION = 1;

/*
 * The constructor for the Moray class.
 *
 * @param {Object} options - an object with the following properties:
 *
 *  - {Object} bucketsConfig (required): an object representing the moray
 *    buckets to setup.
 *
 *  - {Object} changefeedPublisher (required): an instance of
 *    changefeed.Publisher that will be used to publish changes to VM objects
 *    performed via this Moray abstraction layer.
 *
 *  - {Object} dataMigrations (optional): an object representing the data
 *    migrations to run for the moray buckets specified in
 *    "options.bucketsConfig".
 *
 *  - {Object} log (optional): an instance of a bunyan logger that will be used
 *    to log messages.
 *
 *  - {Object} morayClient - the instance of a moray client that will be used by
 *    this Moray instance to perform all operations on the moray database.
 */
function Moray(options) {
    assert.object(options, 'options');
    assert.object(options.morayClient, 'options.morayClient');
    assert.object(options.bucketsConfig, 'options.bucketsConfig');
    assert.object(options.changefeedPublisher, 'options.changefeedPublisher');
    assert.optionalObject(options.log, 'options.log');
    assert.object(options.morayBucketsInitializer,
        'options.morayBucketsInitializer');

    this._bucketsConfig = options.bucketsConfig;
    this._changefeedPublisher = options.changefeedPublisher;
    this._log = options._log || bunyan.createLogger({
        name: 'moray',
        level: options.logLevel || 'info',
        serializers: restify.bunyan.serializers
    });
    this._morayBucketsInitializer = options.morayBucketsInitializer;
    this._morayClient = options.morayClient;

    _validateBucketsConfig(this._bucketsConfig);
    this._VMS_BUCKET_NAME = options.bucketsConfig.vms.name;
    this._VM_ROLE_TAGS_BUCKET_NAME = options.bucketsConfig.vm_role_tags.name;
}

/*
 * Validates that the buckets config "bucketsConfig" is sound, which currently
 * only means that there is some data for all three models that the application
 * uses (vms, server_vms and vm_role_tags). The rest of validation is delegated
 * to Moray when actually setting up the buckets in "bucketsConfig".
 */
function _validateBucketsConfig(bucketsConfig) {
    assert.object(bucketsConfig, 'bucketsConfig');
    assert.object(bucketsConfig.vms, 'bucketsConfig.vms');
    assert.object(bucketsConfig.server_vms, 'bucketsConfig.server_vms');
    assert.object(bucketsConfig.vm_role_tags, 'bucketsConfig.vm_role_tags');
}

/*
 * Returns whether the application model represented by the string "modelName"
 * is valid. Currently it means it has a representation in Moray.
 */
Moray.prototype.isValidModelName = function isValidModelName(modelName) {
    assert.string(modelName, 'modelName');
    assert.object(this._bucketsConfig, 'this._bucketsConfig');

    return Object.keys(this._bucketsConfig).indexOf(modelName) !== -1;
};

/*
 * From a string representing an application model name "modelName", returns its
 * corresponding Moray bucket name.
 */
Moray.prototype._modelToBucketName = function _modelToBucketName(modelName) {
    assert.string(modelName, 'modelName');
    assert.ok(this._bucketsConfig[modelName], 'this._bucketsConfig[' +
        modelName + ']');
    return this._bucketsConfig[modelName].name;
};

/*
 * Returns true if VMAPI's moray buckets have been setup successfully, false
 * otherwise.
 */
Moray.prototype.bucketsSetup = function bucketsSetup() {
    return this._morayBucketsInitializer &&
        this._morayBucketsInitializer.status() &&
        this._morayBucketsInitializer.status().bucketsSetup.state === 'DONE';
};

/*
 * Returns a string representing an error message to signal that the
 * Moray layer's setup process has not completed yet.
 */
Moray.prototype._createMorayBucketsNotSetupErrMsg =
    function _createMorayBucketsNotSetupErrMsg() {
        var bucketsSetupErr;
        var bucketsSetupStatus;
        var errMsg;
        var morayBucketsInitStatus;

        assert.object(this._morayBucketsInitializer,
            'this._morayBucketsInitializer');

        morayBucketsInitStatus = this._morayBucketsInitializer.status();
        assert.object(morayBucketsInitStatus, 'morayBucketsInitStatus');

        bucketsSetupStatus = morayBucketsInitStatus.bucketsSetup;
        assert.object(bucketsSetupStatus, 'bucketsSetupStatus');

        bucketsSetupErr = bucketsSetupStatus.latestError;

        errMsg = 'moray buckets are not setup';
        if (bucketsSetupErr !== null) {
            errMsg += ', reason: ' + bucketsSetupErr;
        }

        return errMsg;
    };



/*
 * Pings Moray by calling its ping method
 */
Moray.prototype.ping = function (callback) {
    // Default ping timeout is 1 second
    return this._morayClient.ping({ log: this._log }, callback);
};


/*
 * Gets a VM object from moray. uuid is required param and owner_uuid is
 * optional
 */
Moray.prototype.getVm = function getVm(params, cb) {
    var uuid = params.uuid;
    var owner = params.owner_uuid;
    var filter = '';
    var error;

    if (!this.bucketsSetup()) {
        cb(new Error(this._createMorayBucketsNotSetupErrMsg()));
        return;
    }

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
    var req = this._morayClient.findObjects(this._VMS_BUCKET_NAME, filter);

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

    if (!this.bucketsSetup()) {
        cb(new Error(this._createMorayBucketsNotSetupErrMsg()));
        return;
    }

    for (i = 0; i < uuids.length; i++) {
        filter += sprintf(PARAM_FILTER, 'uuid', uuids[i]);
    }

    filter = '(|' + filter + ')';
    var vms = [];
    var req = this._morayClient.findObjects(this._VMS_BUCKET_NAME, filter);

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
    _addInternalMetadataFilter(params, filter);

    return cb(null, filter);
};

/*
 * Augments the LDAP filter "filter" with a filter that represents any
 * internal_metadata search parameter in "params". We consider that any
 * validation on such parameters already took place, and thus we consider these
 * parameters valid.
 */
function _addInternalMetadataFilter(params, filter) {
    assert.object(params, 'params');
    assert.arrayOfString(filter, 'filter');

    var FILTER_KEY = 'internal_metadata_search_array';
    var idx;
    var metadataKey;
    var metadataValue;
    var paramNames = Object.keys(params);
    var paramName;

    for (idx = 0; idx < paramNames.length; ++idx) {
        paramName = paramNames[idx];
        if (paramName.indexOf('internal_metadata.') === 0) {
            /*
             * At this point we already validated that the internal_metadata
             * query string parameter is well formed
             * (internal_metadata.metadata_key=value), where "metadata_key" can
             * be any non-empty string (e.g it can have dots in it), so it's
             * fine to parse it without handling bad formats.
             */
            metadataKey = strsplit(paramName, '.', 2)[1];
            metadataValue = params[paramName];

            filter.push(sprintf(PARAM_FILTER, FILTER_KEY,
                metadataKey + '=' + metadataValue));
        }
    }
}
/*
 * This is a bit different to getVm.
 * For this one we need exactly the VM that has the provided UUID
 */
Moray.prototype._getVmObject = function (uuid, cb) {
    if (!this.bucketsSetup()) {
        cb(new Error(this._createMorayBucketsNotSetupErrMsg()));
        return;
    }

    this._morayClient.getObject(this._VMS_BUCKET_NAME, uuid,
        function onGetObject(err, obj) {
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

    if (!self.bucketsSetup()) {
        cb(new Error(this._createMorayBucketsNotSetupErrMsg()));
        return;
    }

    filter += sprintf(PARAM_FILTER_NE, 'state', 'destroyed');
    filter = '(&' + filter + ')';

    var req = self._morayClient.findObjects(self._VMS_BUCKET_NAME, filter);

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

    if (!self.bucketsSetup()) {
        cb(new Error(this._createMorayBucketsNotSetupErrMsg()));
        return;
    }

    self._createSearch(params, function (err, ldapFilter) {
        if (err) {
            return cb(err);
        }

        self._log.info({ filter: ldapFilter }, 'listVms filter');

        var vm;
        var vms = [];
        var filterOptions = _addPaginationOptions(params, ldapFilter);
        var req = self._morayClient.findObjects(self._VMS_BUCKET_NAME,
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

    if (!self.bucketsSetup()) {
        cb(new Error(this._createMorayBucketsNotSetupErrMsg()));
        return;
    }

    self._createSearch(params, function (err, string) {
        if (err) {
            return cb(err);
        }

        var options = {
            limit: 1
        };

        self._log.info({ filter: string }, 'countVms filter');
        var req = self._morayClient.findObjects(self._VMS_BUCKET_NAME, string,
            options);
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
 * Takes two objects, "oldObject" and "newObject" and computes the differences
 * between them. Returns an array that contains the properties that are not
 * equal in oldObject and newObject. If there's no difference between oldObject
 * and newObject, it returns an empty array.
 *
 * @param {Object} oldObject
 * @param {Object} newObject
 * @param {Object} log - the log instance used to log messages.
 */
function computeDiff(oldObject, newObject, log) {
    assert.object(oldObject, 'oldObject');
    assert.object(newObject, 'newObject');
    assert.object(log, 'log');

    var diffs = [];
    var diffResults = deepDiff.diff(oldObject, newObject);
    if (diffResults && diffResults.length) {
        for (var i = 0; i < diffResults.length; i++) {
            var path = diffResults[i].path;
            if (path && path[0]) {
                diffs.push(path[0]);
            } else {
                log.warn('diffResult path not properly set: %j',
                    diffResults[i]);
            }
        }
    }

    return diffs;
}


/*
 * Puts a VM. If it doesn't exist it gets created, if it does exist it gets
 * updated. We no longer need to execute partial updates
 */
Moray.prototype.putVm = function putVm(uuid, vm, oldVm, cb) {
    var self = this;

    assert.uuid(uuid, 'uuid');
    assert.object(vm, 'vm');
    assert.object(oldVm, 'oldVm');
    assert.func(cb, 'cb');

    assert.object(self._changefeedPublisher, 'self._changefeedPublisher');

    var VM_CHANGEFEED_RESOURCE_NAME = 'vm';
    var vmObject = self._toMorayVm(vm);

    if (!this.bucketsSetup()) {
        cb(new Error(this._createMorayBucketsNotSetupErrMsg()));
        return;
    }

    /*
     * Normalize both objects to not contain properties for values that are not
     * set (null, undefined or empty string). This way, we can make sure that
     * the computation of the differences between "oldVm" and "vm" won't find
     * differences between non-existing properties and existing properties with
     * values that are unset.
     */
    oldVm = common.translateVm(oldVm, false);
    vm = common.translateVm(vm, false);

    self._log.debug({vmObject: vmObject, oldVm: oldVm, vm: vm}, 'putting VM');

    self._morayClient.putObject(self._VMS_BUCKET_NAME, uuid, vmObject,
        function onPutObj(putObjErr) {
            var diffs;

            if (!putObjErr) {
                self._log.debug('VM successfully put to moray');

                if (oldVm && self._changefeedPublisher) {
                    diffs = computeDiff(oldVm, vm, self._log);
                    self._log.debug({diffs: diffs},
                        'publishing change to changefeed');
                    common.publishChange(self._changefeedPublisher,
                        VM_CHANGEFEED_RESOURCE_NAME, diffs, vm.uuid,
                        function onChangePublished(publishErr) {
                            if (publishErr) {
                                self._log.error({
                                    err: publishErr
                                }, 'error when publishing change to ' +
                                    'changefeed');
                            } else {
                                self._log.debug('change published to ' +
                                    'changefeed successfully');
                            }

                            cb(publishErr);
                        });
                } else {
                    self._log.debug('not publishing change to changefeed');
                    cb(putObjErr);
                }
            } else {
                self._log.error({err: putObjErr},
                    'error when putting VM to moray');
                cb(putObjErr);
            }
        });
};


/*
 * Deletes *all* VMs that match the filter generated from "params".
 * This API is INTERNAL and should ONLY BE USED FOR WRITING TESTS.
 */
Moray.prototype.delVms = function delVms(params, cb) {
    assert.object(params, 'params');
    assert.func(cb, 'cb');
    var self = this;

    if (!self.bucketsSetup()) {
        cb(new Error(this._createMorayBucketsNotSetupErrMsg()));
        return;
    }

    self._createSearch(params, function (err, filter) {
        if (err) {
            return cb(err);
        }

        // Make sure that the filter is not the filter that selects all VMs.
        // We don't want to allow deletion of all VMs via this API.
        assert.notEqual(filter, SELECT_ALL_FILTER);
        return self._morayClient.deleteMany(self._VMS_BUCKET_NAME, filter,
            params, cb);
    });
};


/*
 * Marks a VM as destroyed
 */
Moray.prototype.markAsDestroyed = function markAsDestroyed(vm, callback) {
    assert.object(vm, 'vm');
    assert.func(callback, 'callback');

    var self = this;

    self._log.debug({vm: vm}, 'Marking VM as destroyed');

    var oldVm = jsprim.deepCopy(vm);

    if (!self.bucketsSetup()) {
        callback(new Error(this._createMorayBucketsNotSetupErrMsg()));
        return;
    }

    var state = (vm.state === 'provisioning') ? 'failed' : 'destroyed';

    vm.state = state;
    vm.zone_state = state;
    if (state === 'destroyed') {
        vm.destroyed = new Date();
    }

    self.putVm(vm.uuid, vm, oldVm, function (err) {
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
 * Gets a bucket
 */
Moray.prototype._getBucket = function (name, cb) {
    this._morayClient.getBucket(name, cb);
};


/*
 * Creates a bucket
 */
Moray.prototype._createBucket = function (name, config, cb) {
    this._morayClient.createBucket(name, config, cb);
};


/*
 * Deletes a bucket
 */
Moray.prototype._deleteBucket = function (name, cb) {
    this._morayClient.delBucket(name, cb);
};


Moray.prototype._updateBucket = function (name, schema, cb) {
    this._morayClient.updateBucket(name, schema, cb);
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

    /*
     * Massage the internal_metadata object and write it to the indexed
     * internal_metadadata_search_array field in a format that is searchable.
     */
    assert.optionalObject(vm.internal_metadata, 'vm.internal_metadata');
    copy.internal_metadata_search_array =
        common.internalMetadataToSearchArray(vm.internal_metadata, {
            log: this._log
        });

    copy.data_version = VM_OBJECTS_DATA_VERSION;

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

    if (!this.bucketsSetup()) {
        cb(new Error(this._createMorayBucketsNotSetupErrMsg()));
        return;
    }

    roleTags.forEach(function (roleTag) {
        filter += sprintf(PARAM_FILTER, 'role_tags', roleTag);
    });

    filter = '(|' + filter + ')';
    var uuids = [];
    var req = this._morayClient.findObjects(this._VM_ROLE_TAGS_BUCKET_NAME,
        filter);

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
    if (!this.bucketsSetup()) {
        cb(new Error(this._createMorayBucketsNotSetupErrMsg()));
        return;
    }

    this._morayClient.getObject(this._VM_ROLE_TAGS_BUCKET_NAME, uuid,
        function (err, obj) {
        if (err) {
            if (verror.hasCauseWithName(err, 'ObjectNotFoundError')) {
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

    if (!this.bucketsSetup()) {
        cb(new Error(this._createMorayBucketsNotSetupErrMsg()));
        return;
    }

    this._morayClient.putObject(this._VM_ROLE_TAGS_BUCKET_NAME, uuid, object,
        cb);
};


/*
 * Deletes all role_tags for a VM
 */
Moray.prototype.delVmRoleTags = function (uuid, cb) {
    if (!this.bucketsSetup()) {
        cb(new Error(this._createMorayBucketsNotSetupErrMsg()));
        return;
    }

    this._morayClient.delObject(this._VM_ROLE_TAGS_BUCKET_NAME, uuid,
        function (err) {
            if (!err ||
                (err && verror.hasCauseWithName(err, 'ObjectNotFoundError'))) {
                cb(null);
            } else {
                cb(err);
            }
        });
};


module.exports = Moray;
