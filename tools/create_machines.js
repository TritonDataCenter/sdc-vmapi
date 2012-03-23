/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var fs = require('fs');
var path = require('path');

var uuid = require('node-uuid');
var ldap = require('ldapjs');
var createMachine = require('./create_machine');

var Logger = require('bunyan');

var log = new Logger({
  name: 'create_machines',
  level: 'debug'
});

var OWNER_UUID = '930896af-bf8c-48d4-885c-6573a94b1853';

var n = parseInt(process.argv[2]) || 1;


var config = function loadConfig() {
  var configPath = path.join(__dirname, '..', 'config.json');

  if (!path.existsSync(configPath)) {
    log.error('Config file not found: '' + configPath +
      '' does not exist. Aborting.');
    process.exit(1);
  }

  var config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return config;
}();



var ufds = ldap.createClient({
  url: config.ufds.url,
  connectTimeout: config.ufds.connectTimeout * 1000
});

ufds.log4js.setGlobalLogLevel('Trace');

var done = n;

ufds.bind(config.ufds.bindDN, config.ufds.bindPassword, function (err) {
  if (err) {
    log.error('Could not bind to UFDS. Aborting.');
    process.exit(1);
  }

  for (i = 0; i < n; i++) {
    createMachine(ufds, OWNER_UUID, function (err, machine) {
      if (err) {
        log.error('Could not create machine');
        log.error(err);
      } else {
        log.info('Machine created.');
      }

      done--;
      if (done == 0) process.exit(0);
    });
  }
});
