/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * This module implements a "loadMigrations" function that loads migration code
 * from a directory on the filesystem. It is used both by the VMAPI server to
 * load actual data migrations code and by tests exercising the data migrations
 * process to load migration fixtures.
 */

var assert = require('assert-plus');
var EventEmitter = require('events');
var fs = require('fs');
var path = require('path');
var vasync = require('vasync');
var util = require('util');

var errors = require('../errors');

var DEFAULT_MIGRATIONS_ROOT_PATH = path.resolve(__dirname, 'migrations');
var InvalidDataMigrationFileNamesError =
    errors.InvalidDataMigrationFileNamesError;
/*
 * A migration module file name *must* start with three digits (in order to make
 * it clear when listing files the order with which the code in these files will
 * be executed), and *must* end with a ".js" file extension.
 */
var MIGRATION_FILE_RE = /^\d{3}-.*\.js$/;

/*
 * Loads all of the data migration code present in a data migrations directory.
 * A data migrations directory is of the following form:
 *
 * data-migrations-root-dir/
 *   vms/
 *     001-some-data-migration.js
 *     002-some-other-data-migration.js
 *   server_vms/
 *     001-some-data-migration.js
 *     002-some-other-data-migration.js
 *   vm_role_tags/
 *     001-some-data-migration.js
 *     002-some-other-data-migration.js
 *
 * The data migrations root dir ("data-migrations-root-dir" in the example
 * above) can have any name. Each of its sub-directory must have the name of a
 * VMAPI Moray bucket, but not all VMAPI Moray buckets must have a data
 * migrations sub-directory: Moray buckets that don't need to have any migration
 * running don't need to have an empty directory present.
 *
 * Each sub-directory must have files using the ".js" extension that can be
 * loaded as a Node.js module using the "require" statement.
 *
 * For a given data migrations sub-directory, the alphanumerical order will be
 * used to determine in which order each data migration is performed.
 *
 * @params {Object} options (optional)
 *   - {String} migrationsRootPath: the root directory where the data migrations
 *     modules are present
 *
 * @params {Function} callback (required): the function called when all data
 *   migration modules have been loaded
 */
function loadMigrations(options, callback) {
    var context = {
        migrations: {}
    };
    var log;
    var migrationsRootPath;

    if (typeof (options) === 'function') {
        callback = options;
        options = undefined;
    }

    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.optionalString(options.migrationsRootPath,
        'options.migrationsRootPath');
    assert.func(callback, 'callback');

    log = options.log;

    migrationsRootPath = options.migrationsRootPath;
    if (migrationsRootPath === undefined) {
        migrationsRootPath = DEFAULT_MIGRATIONS_ROOT_PATH;
    }

    log.info('Loading data migrations from root directory %s',
        migrationsRootPath);

    vasync.pipeline({arg: context, funcs: [
        readRootMigrationDir,
        checkRootMigrationDirEntries,
        readMigrationsDirs
    ]}, function onMigrationsLoaded(err, results) {
        if (err) {
            log.error(err, 'Error when loading data migrations');
        } else {
            log.info('Data migrations loaded successfully');
        }

        callback(err, context.migrations);
    });

    /*
     * First, read the sub-directories under the top-level root directory
     * that represents the containers of migration files for each Moray
     * bucket name.
     */
    function readRootMigrationDir(ctx, next) {
        log.debug('Reading root migration directory');
        fs.readdir(migrationsRootPath,
            function onRootDirRead(rootDirReadErr, dirEntries) {
                if (rootDirReadErr) {
                    log.debug(rootDirReadErr,
                        'Error when reading root migration directory');
                } else {
                    log.debug({dirEntries: dirEntries},
                        'Successfully read root migration directory');
                }

                if (dirEntries) {
                    ctx.migrationsDirPaths =
                        dirEntries.map(function getFullPath(dirEntry) {
                            return path.join(migrationsRootPath, dirEntry);
                        });
                }

                next(rootDirReadErr);
            });
    }

    /*
     * Then, check that these directory entries are actually
     * (sub-)directories, and not any type of directory entry (files, etc.).
     */
    function checkRootMigrationDirEntries(ctx, next) {
        assert.arrayOfString(ctx.migrationsDirPaths,
            'ctx.migrationsDirPaths');

        log.debug({migrationsDirPaths: ctx.migrationsDirPaths},
            'Checking top level migration dir entries');

        vasync.forEachParallel({
            func: function checkIsDirectory(dirPath, done) {
                var err;

                fs.lstat(dirPath,
                    function onLstat(lstatErr, stats) {
                        if (lstatErr) {
                            done(lstatErr);
                            return;
                        }

                        if (!stats || !stats.isDirectory()) {
                            err = new Error(dirPath +
                                ' is not a directory');
                        }

                        done(err);
                    });
            },
            inputs: ctx.migrationsDirPaths
        }, function onTopLevelDirsChecked(checkErr) {
            if (checkErr) {
                log.debug(checkErr,
                    'Error when checking root migration dir entries');
            } else {
                log.debug('Checked root migration dir entries ' +
                    'successfully');
            }

            next(checkErr);
        });
    }

    /*
     * Finally, load each file in those sub-directories as a JS module.
     */
    function readMigrationsDirs(ctx, next) {
        log.debug('Reading data migrations subdirectories');

        vasync.forEachParallel({func: function loadFiles(dirPath, done) {
            var modelName = path.basename(dirPath);

            log.debug({
                dirPath: dirPath
            }, 'Reading data migrations subdirectory');

            fs.readdir(dirPath, function onDirRead(dirReadErr, migrationFiles) {
                var invalidFileNames;

                log.trace({migrationFiles: migrationFiles}, 'migration files');

                if (dirReadErr) {
                    log.error({
                        dirPath: dirPath,
                        err: dirReadErr
                    }, 'Error when reading data migrations subdirectory');
                    done(dirReadErr);
                    return;
                }

                invalidFileNames =
                    migrationFiles.filter(
                        function isInvalidMigrationFilename(fileName) {
                            return !MIGRATION_FILE_RE.test(fileName);
                        });

                log.trace({invalidFileNames: invalidFileNames},
                    'Found %d invalid file names', invalidFileNames.length);

                if (invalidFileNames.length !== 0) {
                    done(new
                        InvalidDataMigrationFileNamesError(invalidFileNames));
                    return;
                }

                /*
                 * Array.sort() sorts "according to unicode code points", so
                 * migration files will be sorted alphanumerically. E.g
                 * 001-foo.js will be sorted (and thus run) before 002-bar.js.
                 */
                migrationFiles.sort();

                ctx.migrations[modelName] =
                    migrationFiles.map(function load(file) {
                        return require(path.join(dirPath, file));
                    });

                done();
            });
        }, inputs: ctx.migrationsDirPaths
        }, function onMigrationDirsRead(readDirsErr) {
            if (readDirsErr) {
                log.error({readDirsErr: readDirsErr},
                    'Error when reading migration dirs');
            } else {
                log.info('Read migration dirs successfully');
            }

            next(readDirsErr);
        });
    }
}

module.exports = {
    loadMigrations: loadMigrations
};