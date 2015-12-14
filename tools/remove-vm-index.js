/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

 var vasync = require('vasync');

 if (process.argv.length !== 3) {
    usage();
} else {
    removeVmIndex(process.argv[2]);
}

function usage() {
    console.log('usage: node remove-vm-index.js index-name');
    process.exit(1);
}

function removeVmIndex(indexName) {
    var bunyan = require('bunyan');
    var restify = require('restify');

    var configLoader = require('../lib/config-loader');
    var MORAY = require('../lib/apis/moray.js');

    var log;

    var config = configLoader.loadConfig();
    console.log(config);

    log = new bunyan({
       name: 'remove-index',
       level: config.logLevel || 'debug',
       serializers: restify.bunyan.serializers
    });

    var moray = new MORAY(config.moray);
    moray.connect();

    moray.once('moray-ready', function onConnectedToMoray() {
       vasync.pipeline({
          funcs: [
            function removeIndex(arg, next) {
                moray.removeVmIndex(indexName, next);
            },
            function reindexVms(arg, next) {
                moray.reindexVms(next);
            }
        ]
        }, function allDone(err, results) {
          log.info('index "' + indexName +
              '"" has been successfully removed');
          moray.connection.close();
        });
    });
}



