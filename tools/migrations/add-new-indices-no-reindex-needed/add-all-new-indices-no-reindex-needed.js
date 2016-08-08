/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * This program is responsible for adding all **new** indices to VMAPI's moray
 * buckets **for which no reindexing is needed**.
 *
 * In order to add a new index to any VMAPI's moray bucket, one should write a
 * *new* program based on the file "add-docker-index.js", and put it in the same
 * directory, then add a reference to this program in the "addIndexMigrations"
 * array below.
 *
 * This program does **not** support adding indices for which any reindexing is
 * needed.
 *
 * Reindexing is needed when adding an index on any property that previous
 * versions of VMAPI could have written. A reference to a program that adds an
 * index for which reindexing is needed should **not be added to the
 * "addIndexMigrations below**. Otherwise, "sdcadm vmapi up" will add that
 * index, but will *not perform the reindexing operation*.
 *
 * Such indices should be added to VMAPI's moray buckets differently.
 */

var child_process = require('child_process');
var path = require('path');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var vasync = require('vasync');

var configLoader = require('../../../lib/config-loader');

var config = configLoader.loadConfig(path.join(__dirname, '..', '..', '..',
    'config.json'));
assert.object(config, 'config');

var log = new bunyan({
    name: 'add-all-indices',
    level: config.logLevel || 'info',
    serializers: bunyan.stdSerializers
});

/*
 * Any program referenced by the "addIndexMigrations" list must have the
 * following characteristics:
 *
 * 1. It mut be idempotent.
 *
 * 2. It must exit with a non-zero exit code if it failed to add the index it is
 * meant to add.
 *
 * 3. It must *only* add *one* index for which *no reindexing is needed*.
 */
var addIndexMigrations = [
    './add-docker-index.js'
];

function runAddIndexMigration(scriptFilePath, callback) {
    assert.string(scriptFilePath, 'scriptFilePath');
    assert.func(callback, 'callback');

    var execArgs = [
        process.argv[0],
        path.resolve(__dirname, scriptFilePath)
    ];

    child_process.exec(execArgs.join(' '),
        function onIndexMigrationDone(err, stdout, stderr) {
            log.debug({
                stdout: stdout,
                stderr: stderr
            }, 'output from ' + scriptFilePath + ' migration');

            return callback(err);
        });
}

vasync.forEachPipeline({
    func: runAddIndexMigration,
    inputs: addIndexMigrations
}, function onAllMigrationsRan(err, results) {
    if (err) {
        log.error({err: err}, 'Error when running indices migrations');
        process.exit(1);
    } else {
        log.info('All indices migrations ran successfully');
    }
});
