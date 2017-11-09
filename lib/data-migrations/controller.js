/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');
var backoff = require('backoff');
var EventEmitter = require('events');
var util = require('util');
var vasync = require('vasync');
var VError = require('verror');

function DataMigrationsController(options) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.object(options.migrations, 'options.migrations');
    assert.object(options.moray, 'options.moray');

    EventEmitter.call(this);

    this._latestErrors = undefined;
    this._latestCompletedMigrations = {};
    this._log = options.log;
    this._migrations = options.migrations;
    this._moray = options.moray;
}
util.inherits(DataMigrationsController, EventEmitter);

function dataMigrationErrorTransient(error) {
    assert.object(error, 'error');

    var idx;
    var nonTransientErrors = [
        /*
         * For now, we consider a bucket not found to be a non-transient error
         * because it's not clear how that error would resolve itself by
         * retrying the data migrations process.
         */
        'BucketNotFoundError',
        'InvalidIndexTypeError',
        'InvalidQueryError',
        /*
         * We consider NotIndexedError errors to be non-transient because data
         * migrations happen *after any schema migration, including reindexing
         * of all affected buckets* is considered to be complete. As a result,
         * when data migrations start, the indexes that are present will not
         * change, and so retrying on such an error would lead to the same error
         * occurring.
         */
        'NotIndexedError',
        /*
         * Unless a specific data migration handles a UniqueAttributeError
         * itself, we consider that retrying that migration would have the same
         * result, so we treat it as a non-transient error.
         */
        'UniqueAttributeError'
    ];

    for (idx = 0; idx < nonTransientErrors.length; ++idx) {
        if (VError.hasCauseWithName(error, nonTransientErrors[idx])) {
            return false;
        }
    }

    return true;
}

DataMigrationsController.prototype.getLatestCompletedMigrationForModel =
function getLatestCompletedMigrationForModel(modelName) {
    assert.string(modelName, 'modelName');

    return this._latestCompletedMigrations[modelName];
};

DataMigrationsController.prototype.getLatestCompletedMigrations =
function getLatestCompletedMigrations() {
    return this._latestCompletedMigrations;
};

DataMigrationsController.prototype.getLatestErrors =
function getLatestErrors() {
    return this._latestErrors;
};

DataMigrationsController.prototype.start = function start() {
    var dataMigrationsBackoff = backoff.exponential();
    var moray = this._moray;
    var self = this;

    moray.validateDataMigrations(this._migrations);
    this._latestErrors = undefined;

    dataMigrationsBackoff.on('backoff',
        function onDataMigrationBackoff(number, delay) {
            self._log.info('Data migration backed off, will retry in %sms',
                delay);
        });

    dataMigrationsBackoff.on('ready', function onMigrationReady(number, delay) {
        self.runMigrations(function onMigrationsRan(dataMigrationErr) {
            if (dataMigrationErr) {
                self._log.error({
                    err: dataMigrationErr,
                    number: number,
                    delay: delay
                }, 'Error when running data migrations');

                if (dataMigrationErrorTransient(dataMigrationErr)) {
                    self._log.info('Error is transient, backing off');
                    dataMigrationsBackoff.backoff();
                } else {
                    self._log.error(dataMigrationErr,
                        'Error is not transient, emitting error');
                    self.emit('error', dataMigrationErr);
                }
            } else {
                self._log.info('All data migrations ran successfully');
                self.emit('done');
            }
        });
    });

    dataMigrationsBackoff.backoff();
};

DataMigrationsController.prototype.runMigrations =
function runMigrations(callback) {
    var modelNames;
    var log = this._log;
    var self = this;

    assert.object(this._migrations, 'this._dataMigrations');

    log.info({dataMigrations: self._migrations}, 'Running data migrations');

    modelNames = Object.keys(this._migrations);

    /*
     * We run data migrations for separate models in *parallel* on purpose. Data
     * migrations are heavily I/O bound, and the number of records for each
     * "model" (or Moray bucket) can vary widely. Thus, performing them in
     * sequence would mean that the migration of a model with very few objects
     * could be significantly delayed by the migration of a model with a much
     * higher number of objects. Instead, data migrations process objects in
     * chunks of a bounded number of objects (currently 1000, the default Moray
     * "page" limit), and thus these data migrations are interleaved, making
     * none of them blocked on each other.
     */
    vasync.forEachParallel({
        func: function runAllMigrationsForSingleModel(modelName, done) {
            self._runMigrationsForModel(modelName, self._migrations[modelName],
                done);
        },
        inputs: modelNames
    }, callback);
};

DataMigrationsController.prototype._runMigrationsForModel =
function _runMigrationsForModel(modelName, dataMigrations, callback) {
    assert.string(modelName, 'modelName');
    assert.arrayOfObject(dataMigrations, 'dataMigrations');
    assert.func(callback, 'callback');

    assert.object(this._log, 'this._log');
    var log = this._log;
    var self = this;

    log.info('Starting data migrations for model %s', modelName);
    self._latestCompletedMigrations = {};

    vasync.forEachPipeline({
        func: function runSingleMigration(migration, next) {
            assert.number(migration.DATA_VERSION, 'migration.DATA_VERSION');
            assert.ok(migration.DATA_VERSION >= 1,
                'migration.DATA_VERSION >= 1');

            self._runSingleMigration(modelName, migration, {
                log: log
            }, function onMigration(migrationErr) {
                if (migrationErr) {
                    if (self._latestErrors === undefined) {
                        self._latestErrors = {};
                    }

                    self._latestErrors[modelName] = migrationErr;

                    log.error({err: migrationErr},
                        'Error when running migration to data version: ' +
                            migration.DATA_VERSION);
                } else {
                    self._latestCompletedMigrations[modelName] =
                        migration.DATA_VERSION;
                    if (self._latestErrors && self._latestErrors[modelName]) {
                        delete self._latestErrors[modelName];
                        if (Object.keys(self._latestErrors).length === 0) {
                            self._latestErrors = undefined;
                        }
                    }
                    log.info('Data migration to data version: ' +
                        migration.DATA_VERSION + ' ran successfully');
                }

                next(migrationErr);
            });
        },
        inputs: dataMigrations
    }, function onAllMigrationsDone(migrationsErr, results) {
        var err;

        if (migrationsErr) {
            err = new VError(migrationsErr, 'Failed to run data migrations');
        }

        callback(err);
    });
};

DataMigrationsController.prototype._runSingleMigration =
function _runSingleMigration(modelName, migration, options, callback) {
    assert.string(modelName, 'modelName');
    assert.object(migration, 'migration');
    assert.func(migration.migrateRecord, 'migration.migrateRecord');
    assert.number(migration.DATA_VERSION, 'migration.DATA_VERSION');
    assert.ok(migration.DATA_VERSION >= 1,
            'migration.DATA_VERSION >= 1');
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    var context = {};
    var log = this._log;
    var self = this;
    var version = migration.DATA_VERSION;

    log.info('Running migration for model %s to data version: %s', modelName,
        version);

    function processNextChunk() {
        vasync.pipeline({arg: context, funcs: [
            function findRecords(ctx, next) {
                self._moray.findRecordsToMigrate(modelName, version, {
                    log: log
                }, function onFindRecords(findErr, records) {
                    if (findErr) {
                        log.error({err: findErr},
                            'Error when finding records not at version: ' +
                                version);
                    } else {
                        log.info('Found ' + records.length + ' records');
                        ctx.records = records;
                    }

                    next(findErr);
                });
            },
            function migrateRecords(ctx, next) {
                var migrateRecordFunc = migration.migrateRecord;
                var migratedRecords;
                var records = ctx.records;

                assert.arrayOfObject(records, 'records');

                if (records.length === 0) {
                    next();
                    return;
                }

                migratedRecords = records.map(function migrate(record) {
                    return migrateRecordFunc(record, {log: log});
                });

                log.trace({migratedRecords: migratedRecords},
                    'Migrated records');

                self._moray.putBatch(modelName, migratedRecords, next);
            }
        ]}, function onChunkProcessed(chunkProcessingErr) {
            var records = context.records;

            if (chunkProcessingErr) {
                log.error({err: chunkProcessingErr},
                    'Error when processing chunk');
                callback(chunkProcessingErr);
                return;
            }

            if (!records || records.length === 0) {
                log.info('No more records at version: ' + version +
                    ', migration done');
                callback();
            } else {
                log.info('Processed ' + records.length + ' records, ' +
                    'scheduling processing of next chunk');
                setImmediate(processNextChunk);
            }
        });
    }

    processNextChunk();
};
module.exports = DataMigrationsController;