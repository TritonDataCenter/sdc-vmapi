/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

// Backfill image_uuid for KVM VMs
var path = require('path');
var fs = require('fs');
var util = require('util');

var bunyan = require('bunyan');
var restify = require('restify');
var moray = require('moray');
var async = require('async');
var levels = [bunyan.TRACE, bunyan.DEBUG, bunyan.INFO,
              bunyan.WARN, bunyan.ERROR, bunyan.FATAL];
var config;
var log;


/*
 * Loads and parse the configuration file at config.json
 */
function loadConfig() {
    var configPath = path.join(__dirname, '..', '..', 'config.json');

    if (!fs.existsSync(configPath)) {
        console.error('Config file not found: ' + configPath +
          ' does not exist. Aborting.');
        process.exit(1);
    }

    var theConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return theConfig;
}

var config = loadConfig();
console.log(config);

log = new bunyan({
    name: 'add-docker-index',
    level: config.logLevel || 'debug',
    serializers: restify.bunyan.serializers
});


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
    var client = moray.createClient({
        connectTimeout: config.moray.connectTimeout || 200,
        host: config.moray.host,
        port: config.moray.port,
        log: log,
        reconnect: true,
        retry: (config.moray.retry === false ? false : {
            retries: Infinity,
            minTimeout: 1000,
            maxTimeout: 16000
        })
    });

    client.on('connect', function () {
        return callback(client);
    });
}

function updateBucket(callback) {
    getMorayClient(function (mclient) {
        morayClient = mclient;
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

