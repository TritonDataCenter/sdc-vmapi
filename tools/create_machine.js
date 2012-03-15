/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var sprintf = require('sprintf').sprintf;
var uuid = require('node-uuid');

var SUFFIX = 'o=smartdc';

var USERS = 'ou=users, ' + SUFFIX;
var USER_FMT = 'uuid=%s, ' + USERS;
var MACHINE_FMT = 'machineid=%s, ' + USER_FMT;


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
 * Creates a machine with random data, just for testing purposes
 */
function createMachine(ufds, owner, callback) {
  var dn, rand, machine, muuid, ram, date;

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
    uuid: muuid
  };

  dn = sprintf(MACHINE_FMT, muuid, owner);

  ufds.add(dn, machine, function(err) {
    if (err)
      callback(err, machine);
    else
      callback(null, machine);
  });
}

module.exports = createMachine;