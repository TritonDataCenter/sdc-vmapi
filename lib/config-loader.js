var path = require('path');
var fs = require('fs');

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
 * Loads and parse the configuration file config.json at the root
 * of the project.
 */
function loadConfig() {
    var configPath = path.join(__dirname, '..', 'config.json');

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

module.exports = {
    loadConfig: loadConfig
};
