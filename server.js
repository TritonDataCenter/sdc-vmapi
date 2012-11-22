/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Main entry-point for the VMs API.
 */

var path = require('path');
var fs = require('fs');

var VMAPI = require('./lib/vmapi');

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


/*
 * Loads and parse the configuration file at config.json
 */
function loadConfig() {
    var configPath = path.join(__dirname, 'config.json');

    if (!fs.existsSync(configPath)) {
        console.error('Config file not found: ' + configPath +
          ' does not exist. Aborting.');
        process.exit(1);
    }

    var theConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return theConfig;
}

var config = loadConfig();
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
    vmapi.log.error('Uncaught Exception', err);
    vmapi.log.error(err.stack);
});


// Increase/decrease loggers levels using SIGUSR2/SIGUSR1:
var sigyan = require('sigyan');
sigyan.add([vmapi.log]);
