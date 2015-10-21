/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var bunyan = require('bunyan');
var restify = require('restify');

var configLoader = require('../../lib/config-loader');
var MORAY = require('../../lib/apis/moray.js');

var log;

var config = configLoader.loadConfig();
console.log(config);

log = new bunyan({
    name: 'add-transitive-state-index',
    level: config.logLevel || 'debug',
    serializers: restify.bunyan.serializers
});

var moray = new MORAY(config.moray);
moray.connect();

moray.once('moray-ready', function onConnectedToMoray() {
    moray.addVmIndex({name: 'transitive_state', type: 'string'},
        function (err) {
        if (err) {
            console.error(err);
            process.exit(1);
            return;
        }

        log.info('"transitive_state" index has been successfully added');
         moray.connection.close();
    });
});


