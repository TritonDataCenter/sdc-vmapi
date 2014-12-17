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

/**
 * boolFromString() "borrowed" from imgapi.git:lib/imgmanifest.js
 *
 * Convert a boolean or string representation (as in redis or UFDS or a
 * query param) into a boolean, or raise TypeError trying.
 *
 * @param value {Boolean|String} The input value to convert.
 * @param default_ {Boolean} The default value is `value` is undefined.
 * @param errName {String} The variable name to quote in the possibly
 *      raised TypeError.
 */
function boolFromString(value, default_, errName) {
    if (value === undefined || value === '') {
        return default_;
    } else if (value === 'false') {
        return false;
    } else if (value === 'true') {
        return true;
    } else if (typeof (value) === 'boolean') {
        return value;
    } else {
        throw new TypeError('invalid value for ' + errName + ': '
            + JSON.stringify(value));
    }
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

    /*
     * Fix Boolean value that should be default-true. hogan templates do not
     * allow us to differentiate between unset and 'false', so we have 3
     * possible string values for a "boolean" here:
     *
     *  ""       - unset, which we should treat as true
     *  "true"
     *  "false"
     *
     * This returns either true or false.
     */
    if (theConfig.hasOwnProperty('reserveKvmStorage')) {
        theConfig.reserveKvmStorage = boolFromString(
            theConfig.reserveKvmStorage, true, 'config.reserveKvmStorage');
    } else {
        // default to true
        theConfig.reserveKvmStorage = true;
    }

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
    vmapi.log.error(err, 'Uncaught Exception');
});


// Increase/decrease loggers levels using SIGUSR2/SIGUSR1:
var sigyan = require('sigyan');
sigyan.add([vmapi.log]);
