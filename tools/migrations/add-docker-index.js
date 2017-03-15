/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var path = require('path');

var bunyan = require('bunyan');
var restify = require('restify');

var configLoader = require('../../lib/config-loader');
var moray = require('moray');

var configFilePath = path.join(__dirname, '..', '..', 'config.json');
var config = configLoader.loadConfig(configFilePath);

var log = new bunyan({
    name: 'add-docker-index',
    level: config.logLevel || 'debug',
    serializers: restify.bunyan.serializers
});

log.info({config: config}, 'Loaded configuration');

/*
 * NOTE: package_version and package_name are deprecated per ZAPI-696 and should
 * be removed whenever this becomes possible.
 */
var BUCKET = {
    name: 'vmapi_vms',
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

function getMorayClient(callback) {
    var morayConfig = config.moray;

    morayConfig.log = log;
    var client = moray.createClient(morayConfig);

    client.on('connect', function () {
        return callback(client);
    });
}

function updateBucket(callback) {
    getMorayClient(function (mclient) {
        var morayClient = mclient;
        morayClient.getBucket(BUCKET.name, function (err, bck) {
            if (err) {
                return callback(err);
            } else if (bck.index.docker !== undefined) {
                log.info('"docker" index already exists, no need to add');
                return callback();
            }

            log.info('adding "docker" index');
            morayClient.updateBucket(BUCKET.name, { index: BUCKET.index },
                callback);
        });
    });
}


updateBucket(function (updateErr) {
    if (updateErr) {
        console.error(updateErr.toString());
        process.exit(1);
        return;
    }

    log.info('"docker" index has been successfully added');
    process.exit(0);
});
