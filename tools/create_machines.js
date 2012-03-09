var fs = require('fs');
var path = require('path');

var sprintf = require('sprintf').sprintf;
var uuid = require('node-uuid');
var ldap = require('ldapjs');

var Logger = require('bunyan');

var log = new Logger({
  name: 'create_machines',
  level: 'debug'
});


var OWNER_UUID = "930896af-bf8c-48d4-885c-6573a94b1853";
var SUFFIX = 'o=smartdc';

var USERS = 'ou=users, ' + SUFFIX;
var USER_FMT = 'uuid=%s, ' + USERS;
var MACHINE_FMT = 'machineid=%s, ' + USER_FMT;

var n = parseInt(process.argv[2]) || 10;

// Machine schema
//
// required: {
//   machineid: 1,
//   ram: 1,
//   disk: 1,
//   swap: 1,
//   lwps: 1,
//   cpucap: 1,
//   cpushares: 1,
//   zfsiopriority: 1
// },
// optional: {
//   alias: 1,
//   internalmetadata: 1,
//   customermetadata: 1,
//   delegatedataset: 1,
//   disks: 0,
//   vcpus: 1,
//   status: 1,
//   setup: 1,
//   destroyed: 1
// }

var TYPES = ["zone", "vm"];
var STATUS = ["running", "off"];
var RAM = [128, 256, 512, 1024];
var DISK = [5120, 10240, 20480, 51200];
var LWPS = 2000;
var CPU_CAP = 350;
var CPU_SHARES = 256
var ZFS_IO = 10;



var config = function loadConfig() {
  var configPath = path.join(__dirname, '..', 'config.json');

  if (!path.existsSync(configPath)) {
    log.error('Config file not found: "' + configPath +
      '" does not exist. Aborting.');
    process.exit(1);
  }

  var config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return config;
}();



var ufds = ldap.createClient({
  url: config.ufds.url,
  connectTimeout: config.ufds.connectTimeout * 1000
});

// ufds.log4js.setGlobalLogLevel('Trace');

ufds.bind(config.ufds.bindDN, config.ufds.bindPassword, function (err) {
  if (err) {
    log.error("Could not bind to UFDS. Aborting.");
    process.exit(1);
  }

  createMachines(n);
});



/*
 * Very simple rand generator with a limit
 */
function randNumber(limit) {
  return Math.floor(Math.random() * limit);
}



/*
 * Very simple random string generator
 */
function randAlias() {
  var text = "";
  var possible = "abcdefghijklmnopqrstuvwxyz";

  for (var i = 0; i < 8; i++)
    text += possible.charAt(Math.floor(Math.random() * possible.length));

  return text;
}



/*
 * Creates n machines with random data, just for testing purposes
 */
function createMachines(n) {
  var i, dn, rand, machine, muuid, ram, date;

  for (i = 0; i < n; i++) {
    date = new Date();
    machine = { objectclass: 'machine' };
    muuid = uuid();

    ram = RAM[randNumber(RAM.length)];

    machine.machineid = muuid;
    machine.ram = ram;
    machine.swap = ram * 2;
    machine.disk = DISK[randNumber(DISK.length)];
    machine.lwps = LWPS;
    machine.cpucap = CPU_CAP;
    machine.cpushares = CPU_SHARES;
    machine.zfsiopriority = ZFS_IO;
    machine.alias = randAlias();
    machine.type = TYPES[randNumber(TYPES.length)];
    machine.status = STATUS[randNumber(STATUS.length)];
    machine.setup = date;

    machine.internalmetadata = {
      mycounter: i
    };

    dn = sprintf(MACHINE_FMT, muuid, OWNER_UUID);

    ufds.add(dn, machine, function(err) {
      if (err) {
        log.error("Could not create machine");
        log.error(err);
        log.error(machine);
      } else {
        // log.info("Machine created");
      }
    });
  }
}