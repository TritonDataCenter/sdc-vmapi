/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var path = require('path');

var bunyan = require('bunyan');

var configLoader = require('../../../lib/config-loader');
var MORAY = require('../../../lib/apis/moray.js');

var config = configLoader.loadConfig(path.join(__dirname, '..', '..', '..',
    'config.json'));

var log = new bunyan({
    name: 'add-docker-index',
    level: config.logLevel || 'debug',
    serializers: bunyan.stdSerializers
});

var moray = new MORAY(config.moray);
moray.connect();

moray.once('moray-ready', function onConnectedToMoray() {
    moray.addVmIndex({name: 'docker', type: 'string'}, function (err) {
        moray.connection.close();

        if (err) {
            console.error(err);
            process.exit(1);
            return;
        }

        log.info('"docker" index has been successfully added');
    });
});
