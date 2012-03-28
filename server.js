/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Main entry-point for the Zones API.
 */

var path = require('path');
var fs = require('fs');

var ZAPI = require('./lib/zapi');

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

  if (!path.existsSync(configPath)) {
    log.error('Config file not found: ' + configPath +
      ' does not exist. Aborting.');
    process.exit(1);
  }

  var config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return config;
}

var config = loadConfig();
config.version = version() || '7.0.0';


var zapi;

try {

  var zapi = new ZAPI(config);
  zapi.init();

} catch (e) {
  console.error('Invalid UFDS config: ' + e.message);
  process.exit(1);
}


zapi.on('ready', function () {
  zapi.listen();
});


zapi.on('error', function (err) {
  zapi.log.error(err, 'error connecting to UFDS. Aborting.');
  process.exit(1);
});
