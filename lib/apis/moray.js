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
var VM_MIGRATE_OBJECTS_DATA_VERSION = 1;

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

    this._bucketsConfig = options.bucketsConfig;
    this._changefeedPublisher = options.changefeedPublisher;
    this._log = options._log || bunyan.createLogger({
        name: 'moray',
        level: options.logLevel || 'info',
        serializers: restify.bunyan.serializers
    });
    this._morayClient = options.morayClient;

    this._bucketsSetup = false;
    this._lastBucketsSetupError = null;
    this._reindexingBuckets = false;
    this._settingUpBuckets = false;

    this._latestCompletedMigration = undefined;

    _validateBucketsConfig(this._bucketsConfig);
}

/*
 * Validates that the buckets config "bucketsConfig" is sound, which currently
 * only means that there is some data for all models that the application uses.
 * The rest of validation is delegated to Moray when actually setting up the
 * buckets in "bucketsConfig".
 */
function _validateBucketsConfig(bucketsConfig) {
    assert.object(bucketsConfig, 'bucketsConfig');
    assert.object(bucketsConfig.vms, 'bucketsConfig.vms');
    assert.object(bucketsConfig.server_vms, 'bucketsConfig.server_vms');
    assert.object(bucketsConfig.vm_role_tags, 'bucketsConfig.vm_role_tags');
    assert.object(bucketsConfig.vm_migrations, 'bucketsConfig.vm_migrations');
}

/*
 * Validates that data migrations represented by "dataMigrations" are sound. For
 * instance, it checks that for each model that needs to be migrated, its
 * corresponding moray bucket configuration includes a "data_version" indexed
 * field. It also makes sure that versioning of subsequent data migrations for a
 * given model follows a sequence.
 */
Moray.prototype.validateDataMigrations =
function validateDataMigrations(dataMigrations) {
    var bucketConfig;
    var bucketName;
    var expectedDataVersion;
    var idx;
    var migrationsForBucket;

    assert.object(this._bucketsConfig, 'this._bucketsConfig');
    assert.object(dataMigrations, 'dataMigrations');

    for (bucketName in dataMigrations) {
        bucketConfig = this._bucketsConfig[bucketName];

        assert.object(bucketConfig, 'bucketConfig');
        assert.object(bucketConfig.schema.index.data_version,
            'data_version indexed field should be present in bucket config');
        assert.equal(bucketConfig.schema.index.data_version.type, 'number',
            'data_version indexed field should be of type \'number\'');

        migrationsForBucket = dataMigrations[bucketName];
        expectedDataVersion = 1;
        /*
         * Validates that all data migrations that need to be performed are
         * valid. For instance, that their DATA_VERSION numbers are a proper
         * sequence starting at 1, and that they export a function named
         * "migrateRecord".
         */
        for (idx = 0; idx < migrationsForBucket.length; ++idx) {
            assert.equal(migrationsForBucket[idx].DATA_VERSION,
                expectedDataVersion, 'Data version of migration ' + (idx + 1) +
                    ' should be ' + expectedDataVersion);
            assert.func(migrationsForBucket[idx].migrateRecord,
                    'migrationsForBucket[' + idx + '].migrateRecord');
            ++expectedDataVersion;
        }
    }
};

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
 * Returns true if the "err" error object represents a transient error (an error
 * that could be solved after retrying the same action) that can happen during
 * the process of setting up Moray buckets.
 */
Moray.prototype.isBucketsSetupErrorTransient =
    function isBucketsSetupErrorTransient(err) {
        assert.object(err, 'err');
        assert.string(err.name, 'err.name');

        var nonTransientErrName;
        var NON_TRANSIENT_ERROR_NAMES = [
            /* Errors sent by the moray server */
            'InvalidBucketConfigError',
            'InvalidBucketNameError',
            'InvalidIndexDefinitionError',
            'NotFunctionError',
            'BucketVersionError',
            /* Custom errors generated by this Moray abstraction layer */
            'InvalidIndexesRemovalError'
        ];

        for (var idx in NON_TRANSIENT_ERROR_NAMES) {
            nonTransientErrName = NON_TRANSIENT_ERROR_NAMES[idx];
            if (verror.hasCauseWithName(err, nonTransientErrName)) {
                return false;
            }
        }

        return true;
    };


/*
 * Sets up VMAPI's moray buckets, including creating them if they're
 * missing, or updating them if they already exist. Calls the 'callback'
 * function when that setup completed.
 *
 * It does not perform any reindexing of rows that would need to be reindexed
 * after a bucket was updated to add one or more indexes. To reindex rows of all
 * buckets, use the "Moray.prototype.reindexBuckets" function.
 *
 * If the setup results in an error, the first argument of the 'callback'
 * function is an Error object. The
 * 'Moray.prototype.isBucketsSetupErrorNonTransient' function can be used to
 * determine whether that error is non transient, and how to act on it depending
 * on the program's expectations and behavior.
 *
 * The "Moray.prototype.setupBuckets" function can be called more than once per
 * instance of the Moray constructor, as long as each call is made after the
 * previous setup process terminated, either successfully or with an error, by
 * calling the 'callback' function passed as a parameter. Calling this method
 * while a previous call is still in flight will throw an error.
 */
Moray.prototype.setupBuckets = function setupBuckets(callback) {
    var self = this;
    var bucketsList = [];
    var bucketConfig;

    if (self._settingUpBuckets === true) {
        throw new Error('setupBuckets cannot be called when a setup ' +
            'process is in progress');
    }

    self._lastBucketsSetupError = null;
    self._settingUpBuckets = true;

    self._log.info({bucketsConfig: self._bucketsConfig},
        'Setting up moray buckets...');

    self._VMS_BUCKET_NAME = self._bucketsConfig.vms.name;
    self._VM_ROLE_TAGS_BUCKET_NAME = self._bucketsConfig.vm_role_tags.name;
    self._VM_MIGRATIONS_BUCKET_NAME = self._bucketsConfig.vm_migrations.name;

    for (bucketConfig in self._bucketsConfig) {
        bucketsList.push(self._bucketsConfig[bucketConfig]);
    }

    self._trySetupBuckets(bucketsList, function (setupBucketsErr) {
        self._settingUpBuckets = false;
        self._lastBucketsSetupError = setupBucketsErr;

        if (setupBucketsErr) {
            self._log.error({ error: setupBucketsErr },
                'Error when setting up moray buckets');
        } else {
            self._log.info('Buckets have been setup successfully');
            self._bucketsSetup = true;
        }

        callback(setupBucketsErr);
    });
};


/*
 * Returns true if VMAPI's moray buckets have been setup successfully, false
 * otherwise.
 */
Moray.prototype.bucketsSetup = function bucketsSetup() {
    return this._bucketsSetup;
};


/*
 * Returns an Error instance that represents the latest error that occured
 * during the process of setting up Moray buckets (but not reindexing), or null
 * if no error occurred since the last time "Moray.prototype.setupBuckets" was
 * called.
 */
Moray.prototype.lastBucketsSetupError = function lastBucketsSetupError() {
    return this._lastBucketsSetupError;
};


/*
 * Returns a string representing an error message to signal that the
 * Moray layer's setup process has not completed yet.
 */
Moray.prototype._createMorayBucketsNotSetupErrMsg =
    function _createMorayBucketsNotSetupErrMsg() {
        var errMsg = 'moray buckets are not setup';

        if (this._lastBucketsSetupError !== null) {
            errMsg += ', reason: ' + this._lastBucketsSetupError;
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
        cb(new verror.VError('Moray buckets are not setup',
            this._lastBucketsSetupError));
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
 * Tries to setup VMAPI's moray buckets as specified by the array "buckets".
 * Calls the function "cb" when done. If there was an error, the "cb" function
 * is called with an error object as its first parameter, otherwise it is called
 * without passing any parameter.
 */
Moray.prototype._trySetupBuckets =
    function _trySetupBuckets(buckets, cb) {
        assert.arrayOfObject(buckets, 'buckets');
        assert.func(cb, 'cb');

        var self = this;

        vasync.forEachPipeline({
            func: function setupEachBucket(newBucketConfig, done) {
                var bucketName = newBucketConfig.name;
                assert.string(bucketName, 'bucketName');

                self._trySetupBucket(bucketName, newBucketConfig, done);
            },
            inputs: buckets
        }, cb);
    };


/*
 * Returns true if the updating a moray bucket from the bucket schema
 * "oldBucketSchema" to "newBucketSchema" would imply removing at least one
 * index. Returns false otherwise.
 */
function indexesRemovedBySchemaChange(oldBucketSchema, newBucketSchema) {
    assert.object(oldBucketSchema, 'oldBucketSchema');
    assert.object(newBucketSchema, 'newBucketSchema');

    var oldBucketIndexNames = [];
    var newBucketIndexNames = [];

    if (oldBucketSchema.index) {
        oldBucketIndexNames = Object.keys(oldBucketSchema.index);
    }

    if (newBucketSchema.index) {
        newBucketIndexNames = Object.keys(newBucketSchema.index);
    }

    var indexesRemoved =
        oldBucketIndexNames.filter(function indexMissingInNewSchema(indexName) {
            return newBucketIndexNames.indexOf(indexName) === -1;
        });

    return indexesRemoved;
}


/*
 * Tries to set up bucket with name "bucketName" to have configuration
 * "bucketConfig". The setup process includes, in the following order:
 *
 * 1. creating the bucket if it does not exist.
 *
 * 2. updating the bucket's indexes to add indexes. Indexes cannot be removed
 * because it's a backward incompitble change: if a code rollback is performed,
 * older code that would rely on the deleted indexes wouldn't be able to work
 * properly, and removing indexes will generate an error.
 *
 */
function _trySetupBucket(bucketName, bucketConfig, cb) {
    assert.string(bucketName, 'bucketName');
    assert.object(bucketConfig, 'bucketConfig');
    assert.object(bucketConfig.schema, 'bucketConfig.schema');
    assert.optionalObject(bucketConfig.schema.options,
        'bucketConfig.schema.options');
    if (bucketConfig.schema.options) {
        assert.optionalNumber(bucketConfig.schema.options.version,
            'bucketConfig.schema.options.version');
    }

    assert.func(cb, 'cb');

    var self = this;

    var newBucketSchema = bucketConfig.schema;

    vasync.waterfall([
        function loadBucket(next) {
            self._getBucket(bucketName, function (err, oldBucketSchema) {
                if (err &&
                    verror.hasCauseWithName(err, 'BucketNotFoundError')) {
                    err = null;
                }

                next(err, oldBucketSchema);
            });
        },
        function createBucket(oldBucketSchema, next) {
            if (!oldBucketSchema) {
                self._log.info({bucketName: bucketName},
                    'Bucket not found, creating it...');
                self._createBucket(bucketName, bucketConfig.schema,
                    function createDone(createErr) {
                        if (createErr) {
                            self._log.error({
                                bucketName: bucketName,
                                error: createErr.toString()
                            }, 'Error when creating bucket');
                        } else {
                            self._log.info('Bucket ' +
                                bucketName +
                                    ' created successfully');
                        }

                        next(createErr, oldBucketSchema);
                    });
             } else {
                self._log.info({bucketName: bucketName},
                    'Bucket already exists, not creating it.');
                next(null, oldBucketSchema);
            }
        },
        function updateBucketSchema(oldBucketSchema, next) {
            assert.optionalObject(oldBucketSchema, 'oldBucketSchema');

            var oldVersion = 0;
            var newVersion = 0;
            var removedIndexes = [];

            if (oldBucketSchema && oldBucketSchema.options &&
                oldBucketSchema.options.version) {
                oldVersion = oldBucketSchema.options.version;
            }

            if (newBucketSchema.options && newBucketSchema.options.version) {
                newVersion = newBucketSchema.options.version;
            }

            /*
             * If the bucket's version was bumped, update the bucket, otherwise:
             *
             * 1. the version number wasn't bumped because no change was made
             * and there's nothing to do.
             *
             * 2. the version number is lower than the current version number in
             * moray. This can be the result of a code rollback. Since we make
             * only backward compatible changes for moray buckets, and
             * decrementing a bucket's version number is an error, it's ok to
             * not change the bucket.
             */
            if (oldBucketSchema && newVersion > oldVersion) {
                removedIndexes = indexesRemovedBySchemaChange(oldBucketSchema,
                    newBucketSchema);
                if (removedIndexes.length > 0) {
                    /*
                     * Removing indexes is considered to be a backward
                     * incompatible change. We don't allow them so that after
                     * rolling back to a previous version of the code, the code
                     * can still use any index that it relies on.
                     */
                    next(new errors.InvalidIndexesRemovalError(removedIndexes));
                    return;
                }

                self._log.info('Updating bucket ' + bucketName + ' from ' +
                    'version ' + oldVersion + ' to version ' + newVersion +
                    '...');

                self._updateBucket(bucketName, newBucketSchema,
                    function updateDone(updateErr) {
                        if (updateErr) {
                            self._log.error({error: updateErr},
                                'Error when updating bucket ' +
                                    bucketName);
                        } else {
                            self._log.info('Bucket ' + bucketName +
                                ' updated successfully');
                        }

                        next(updateErr);
                    });
            } else {
                self._log.info('Bucket ' + bucketName + ' already at version ' +
                    '>= ' + newVersion + ', no need to update it');
                next(null);
            }
        }
    ], cb);
}
Moray.prototype._trySetupBucket = _trySetupBucket;


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



/**
 * VM Migrations
 */


/*
 * Get all vm migrations that match the given criteria (an array). Returns a
 * list of vm migration objects. Note that the array of migrations will be
 * returned in descending created_timestamp order.
 */
Moray.prototype.getVmMigrations = function (params, cb) {
    assert.object(params, 'params');
    assert.func(cb, 'cb');

    var filter = '';
    var findOptions = {
        sort: {
            order: 'DESC',
            attribute: 'created_timestamp'
        }
    };
    var migrations = [];
    var req;
    var self = this;

    if (!self.bucketsSetup()) {
        cb(new Error(self._createMorayBucketsNotSetupErrMsg()));
        return;
    }

    Object.keys(params).forEach(function (param) {
        var schemaIndex = self._bucketsConfig.vm_migrations.schema.index;
        if (!schemaIndex.hasOwnProperty(param)) {
            self._log.trace('vm migration schema has no indexed field: "%s"',
                param);
            return;
        }
        if (param === 'state' && params[param] === 'active') {
            // Active is considering 'running', 'paused' or 'failed'.
            filter += '(|(state=running)(state=paused)(state=failed))';
        } else if (param === 'source_server_uuid') {
            // Match to the current source_server_uuid or in the case of a
            // finished migration, match the target_server_uuid.
            filter += sprintf('(|%s(&%s(state=successful)))',
                sprintf(PARAM_FILTER, param, params[param]),
                sprintf(PARAM_FILTER, 'target_server_uuid', params[param]));
        } else {
            filter += sprintf(PARAM_FILTER, param, params[param]);
        }
    });

    if (filter) {
        filter = '(&' + filter + ')';
    } else {
        filter = '(id=*)';
    }

    self._log.info({filter: filter}, 'getVmMigrations');

    req = self._morayClient.findObjects(self._VM_MIGRATIONS_BUCKET_NAME,
        filter, findOptions);

    req.once('error', function (err) {
        return cb(err);
    });

    req.on('record', function (object) {
        migrations.push(object.value);
    });

    req.once('end', function () {
        return cb(null, migrations);
    });
};


/*
 * Get the active vm migration for the provideded params.
 */
Moray.prototype.getVmMigrationByParams = function (params, cb) {
    this.getVmMigrations(params, function _getVmMigrationsCb(err, migrations) {
        if (err) {
            cb(err);
            return;
        }

        if (!migrations || migrations.length === 0) {
            cb(new restify.ResourceNotFoundError('migration not found'));
            return;
        }

        // Return the first entry - as that is the most recent migration
        // record, note that getVmMigrations returns migrations sorted by
        // created_timestamp in *descending* order.
        cb(null, migrations[0]);
    });
};


/*
 * Get the vm migration for this vm uuid.
 */
Moray.prototype.getVmMigrationByVmUuid = function (vm_uuid, cb) {
    assert.uuid(vm_uuid, 'vm_uuid');

    var params = {
        vm_uuid: vm_uuid
    };

    this.getVmMigrationByParams(params, cb);
};


/*
 * Get the vm migration for this migration id.
 */
Moray.prototype.getVmMigrationById = function (id, cb) {
    assert.uuid(id, 'id');

    var params = {
        id: id
    };

    this.getVmMigrationByParams(params, cb);
};


/*
 * Converts to a moray VM migration record.
 */
Moray.prototype._toMorayVmMigrationRecord = function (migration) {
    assert.object(migration, 'migration');
    assert.uuid(migration.vm_uuid, 'migration.vm_uuid');
    assert.uuid(migration.source_server_uuid, 'migration.source_server_uuid');

    var copy = jsprim.deepCopy(migration);

    // // Convert timestamps to string format.
    // var timestampFields = [
    //     'created_timestamp',
    //     'scheduled_timestamp',
    //     'started_timestamp',
    //     'finished_timestamp'
    // ];
    // timestampFields.forEach(function (key) {
    //     var isDate = (copy[key] !== null &&
    //         typeof (copy[key]) === 'object' &&
    //         copy[key].getMonth !== undefined);

    //     if (typeof (copy[key]) === 'string') {
    //         copy[key] = new Date(copy[key]).getTime();
    //     } else if (isDate) {
    //         copy[key] = copy[key].getTime();
    //     }
    // });

    // Only stringify these fields when they are in object form.
    // var objectFields = [
    //     'previous_jobs',
    //     'progress_history'
    // ];
    // objectFields.forEach(function (key) {
    //     if (copy[key] && typeof (copy[key]) === 'object') {
    //         copy[key] = JSON.stringify(copy[key]);
    //     }
    // });

    copy.data_version = VM_MIGRATE_OBJECTS_DATA_VERSION;

    return copy;
};


/*
 * Validates the moray VM migration record.
 *
 * Returns null on success, error on failure.
 */
Moray.prototype._validateVmMigrationRecord =
function _validateVmMigrationRecord(record) {
    assert.object(record, 'migration');

    // Moray itself will validate the indexed fields - we validate the other
    // properties here.
    var errs = [];

    var REQUIRED_FIELDS = {
        // TODO: Fill out fields.
    };

    var OPTIONAL_FIELDS = {
        // TODO: Fill out fields.
    };

    Object.keys(REQUIRED_FIELDS).forEach(function _requiredRecordField(field) {
        var expectedType = REQUIRED_FIELDS[field];
        if (!record.hasOwnProperty(field)) {
            errs.push('missing field "' + field + '"');
        } else if (typeof (record[field]) !== expectedType) {
            errs.push('invalid field "' + field + '"');
        }
    });

    Object.keys(OPTIONAL_FIELDS).forEach(function _optionalRecordField(field) {
        var expectedType = OPTIONAL_FIELDS[field];
        if (record.hasOwnProperty(field) &&
                typeof (record[field]) !== expectedType) {
            errs.push('invalid field "' + field + '"');
        }
    });

    if (errs.length > 0) {
        return new Error('Invalid migration record: ' + errs.join(','));
    }

    return null;
};

/*
 * Puts a VM migration. If it doesn't exist it gets created, if it does exist
 * it gets updated.
 */
Moray.prototype.putVmMigration = function putVmMigration(migration, cb) {
    assert.object(migration, 'migration');
    assert.uuid(migration.id, 'migration.id');
    assert.func(cb, 'cb');

    var self = this;
    var record = self._toMorayVmMigrationRecord(migration);
    var validationError = self._validateVmMigrationRecord(record);

    if (validationError) {
        cb(validationError);
        return;
    }

    if (!self.bucketsSetup()) {
        cb(new Error(self._createMorayBucketsNotSetupErrMsg()));
        return;
    }

    self._log.debug({record: record}, 'putting VM migration record');

    self._morayClient.putObject(self._VM_MIGRATIONS_BUCKET_NAME, record.id,
            record, function onPutMigrationObj(putErr, obj) {
        if (putErr) {
            self._log.error({err: putErr},
                'error when putting VM migration record to moray');
        } else {
            self._log.debug('VM migration record successfully put to moray');
        }
        cb(putErr, obj);
    });
};


/*
 * Deletes one vm migration record.
 */
Moray.prototype.delVmMigration = function (id, cb) {
    if (!this.bucketsSetup()) {
        cb(new Error(this._createMorayBucketsNotSetupErrMsg()));
        return;
    }

    this._morayClient.delObject(this._VM_MIGRATIONS_BUCKET_NAME, id,
        function onDeleteMigrationObj(err) {
            if (!err ||
                (err && verror.hasCauseWithName(err, 'ObjectNotFoundError'))) {
                cb(null);
            } else {
                cb(err);
            }
        });
};


/*
 * Reindexes all objects in the bucket with name "bucketName" and calls the
 * function "callback" when it's done.
 *
 * @param moray {MorayClient}
 * @param bucketName {Name of the bucket to reindex}
 * @param callback {Function} `function (err)`
 */
Moray.prototype._reindexBucket =
    function _reindexBucket(bucketName, callback) {
        assert.string(bucketName, 'bucketName');
        assert.func(callback, 'callback');

        var self = this;

        self._morayClient.reindexObjects(bucketName, 100,
            function onReindexBucketDone(reindexErr, res) {
                if (reindexErr || res.processed < 1) {
                    callback(reindexErr);
                    return;
                }

                self._reindexBucket(bucketName, callback);
            });
    };

/*
 * Reindexes all buckets and calls "callback" when it's done.
 *
 * @param {Function} callback - a function called when either the reindexing
 *   process is complete for all buckets, or when an error occurs. It is called
 *   as "callback(null)" if the reindexing process completed with no error, or
 *   "callback(err)"" if the error "err" occurred.
 */
Moray.prototype.reindexBuckets = function reindexBuckets(callback) {
    assert.func(callback, 'callback');

    var bucketsList = [];
    var bucketConfigName;
    var self = this;

    if (self._reindexingBuckets === true) {
        throw new Error('reindexBuckets cannot be called when a reindexing ' +
            'process is in progress');
    }

    self._reindexingBuckets = true;

    for (bucketConfigName in this._bucketsConfig) {
        bucketsList.push(this._bucketsConfig[bucketConfigName]);
    }

    vasync.forEachPipeline({
        func: function reindexBucket(bucketConfig, done) {
            assert.object(bucketConfig, 'bucketConfig');
            assert.string(bucketConfig.name, 'bucketConfig.name');

            var bucketName = bucketConfig.name;

            self._log.info('Reindexing bucket ' + bucketName + '...');

            self._reindexBucket(bucketName, function reindexDone(reindexErr) {
                if (reindexErr) {
                    self._log.error({err: reindexErr},
                        'Error when reindexing bucket ' + bucketName);
                } else {
                    self._log.info('Bucket ' + bucketName +
                        ' reindexed successfully');
                }

                done(reindexErr);
            });
        },
        inputs: bucketsList
    }, function onAllBucketsReindexed(reindexErr) {
        self._reindexingBuckets = false;
        callback(reindexErr);
    });
};

/*
 * Finds the next chunk of records that need to be changed to be migrated to
 * version "version".
 *
 * @param {String} modelName: the name of the model (e.g "vms", "vm_role_tags",
 *   "server_vms") for which to find records to migrate
 *
 * @param {Number} version: must be >= 1.
 *
 * @param {Object} options:
 *   - log {Object}: the bunyan log instance to use to output log messages.
 *
 * @param {Function} callback: called with two parameters: (error, records)
 *   where "error" is any error that occurred when trying to find those records,
 *   and "records" is an array of objects representing VM objects that need to
 *   be changed to be migrated to version "version".
 */
Moray.prototype.findRecordsToMigrate =
function findRecordsToMigrate(modelName, version, options, callback) {
    assert.string(modelName, 'bucketName');
    assert.number(version, 'version');
    assert.ok(version >= 1, 'version >= 1');
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    var bucketName = this._modelToBucketName(modelName);
    var log = this._log;
    var morayFilter;
    var records = [];
    var RETRY_DELAY_IN_MS = 10000;
    var self = this;

    /*
     * !!!! WARNING !!!!
     *
     * When updating these LDAP filters, make sure that they don't break the
     * assumption below that an InvalidQueryError can be treated as a transient
     * error (See below why.).
     *
     * !!!! WARNING !!!!
     */
    if (version === 1) {
        /*
         * Version 1 is special, in the sense that there's no anterior version
         * for which data_version has a value. Instead, the version before
         * version 1 is represented by an absence of value for the data_version
         * field.
         */
        morayFilter = '(!(data_version=*))';
    } else {
        /*
         * For any migration whose version number is greater than one, they only
         * migrate records at version N - 1. This is safe because:
         *
         * 1. all new records created are created at the latest version
         *    supported by VMAPI
         *
         * 2. migrations are always done in sequence, starting from the
         *    migration that migrates records without a data_version to records
         *    with a data_version === 1.
         */
        morayFilter = util.format('(|(!(data_version=*))(data_version=%s))',
            version - 1);
    }

    log.debug({filter: morayFilter, version: version},
        'generated LDAP filter to find records at version less than given ' +
            'version');

    /*
     * It would be useful to pass either the requireIndexes: true or
     * requireOnlineReindexing: true options to findObjects here, as that would
     * allow us to make sure that we can actually rely on the results from this
     * query. However:
     *
     * 1. We don't want to rely on a specific version of the Moray server.
     *    Support for these options is fairly new (see
     *    http://smartos.org/bugview/MORAY-104 and
     *    http://smartos.org/bugview/MORAY-428) and being able to perform data
     *    migrations is a basic requirement of the service, so we don't want to
     *    prevent that from happening if Moray was rolled back in a DC to a
     *    version that doesn't support those flags. Moreover, at the time data
     *    migrations were added, the latest version of the manta-moray image in
     *    the "support" channel of updates.joyent.com did not include MORAY-104
     *    or MORAY-428.
     *
     * 2. Since this filter uses only one field, Moray already has a mechanism
     *    that will return an InvalidQueryError in case this field is not
     *    indexed, which effectively acts similarly to those two different
     *    options mentioned above.
     */
    var req = this._morayClient.findObjects(bucketName, morayFilter);

    req.once('error', function onRecordsNotAtVersionError(err) {
        log.error({err: err},
            'Error when finding next chunk of records to migrate');

        if (verror.hasCauseWithName(err, 'InvalidQueryError')) {
            /*
             * We treat InvalidQueryError here as a transient error and retry
             * when it occurs because:
             *
             * 1. We know that the LDAP filter passed to the findObjects request
             *    uses only one field, and that field was added with the same
             *    code change than this code.
             *
             * 2. We know that data migrations are run *after* reindexing of all
             *    buckets is completed and successful.
             *
             * As a result, we can rely on this field being indexed and
             * searchable, and we know that an InvalidQueryError is returned by
             * the Moray server only when the bucket cache of the Moray instance
             * that responded has not been refreshed yet.
             */
            log.info('Scheduling retry in ' + RETRY_DELAY_IN_MS + ' ms');
            setTimeout(function retry() {
                log.info({version: version},
                        'Retrying to find records at version less than');
                self.findRecordsToMigrate(modelName, version, options,
                    callback);
            }, RETRY_DELAY_IN_MS);
        }
    });

    req.on('record', function onRecord(record) {
        records.push(record);
    });

    req.once('end', function onEnd() {
        callback(null, records);
    });
};

/*
 * Generates a Moray batch request to PUT all objects in the array of objects
 * "records", and call "callback" when it's done.
 *
 * @params {String} modelName: the name of the model (e.g "vms", "vm_role_tags",
 *   "server_vms") for which to generate a PUT batch operation
 *
 * @params {ArrayOfObjects} records
 *
 * @params {Function} callback(err)
 */
Moray.prototype.putBatch = function putBatch(modelName, records, callback) {
    assert.string(modelName, 'modelName');
    assert.arrayOfObject(records, 'records');
    assert.func(callback, 'callback');

    var bucketName = this._modelToBucketName(modelName);
    assert.string(bucketName, 'bucketName');

    this._morayClient.batch(records.map(function generateVmPutBatch(record) {
        assert.string(record.key, 'record.key');
        return {
            bucket: bucketName,
            operation: 'put',
            key: record.key,
            value: record.value,
            etag: record._etag
        };
    }), function onBatch(batchErr, meta) {
        /*
         * We don't care about the data in "meta" for now (the list of etags
         * resulting from writing all records), and adding it later would be
         * backward compatible.
         */
        callback(batchErr);
    });
};

module.exports = Moray;
