/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Main entry-point for the VMs API.
 */

var path = require('path');
var fs = require('fs');

var VMAPI = require('./lib/vmapi');
var configLoader = require('./lib/config-loader');

var VERSION = false;


/**
 * Returns the current semver version stored in CloudAPI's package.json.
 * This is used to set in the API versioning and in the Server header.
 *
 * @return {String} version.
 */
function version() {
    if (!VERSION) {
        var pkg = fs.readFileSync(__dirname + '/package.json', 'utf8');
        VERSION = JSON.parse(pkg).version;
    }

    return VERSION;
}

var configFilePath = path.join(__dirname, 'config.json');
var config = configLoader.loadConfig(configFilePath);
config.version = version() || '7.0.0';


var vmapi;

try {
    vmapi = new VMAPI(config);
    vmapi.init();
} catch (e) {
    console.error('Error produced when initializing VMAPI services');
    console.error(e.message);
    console.error(e.stack);
}

vmapi.once('ready', function () {
    vmapi.log.info('All services are up');
});

process.on('uncaughtException', function (err) {
    vmapi.log.error(err, 'Uncaught Exception');
});


// Increase/decrease loggers levels using SIGUSR2/SIGUSR1:
var sigyan = require('sigyan');
sigyan.add([vmapi.log]);
