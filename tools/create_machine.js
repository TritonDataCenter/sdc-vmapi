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
var MACHINE_FMT = 'machine=%s, ' + USER_FMT;

var STATUS = ['running', 'off'];
var BRANDS = ['joyent', 'kvm'];
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
    var text = '';
    var possible = 'abcdefghijklmnopqrstuvwxyz';

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

    machine.uuid = muuid;
    machine.ram = ram;
    machine.max_physical_memory = ram;
    machine.max_swap = ram * 2;
    machine.quota = DISK[randNumber(DISK.length)];
    machine.max_lwps = LWPS;
    machine.cpu_cap = CPU_CAP;
    machine.cpu_shares = CPU_SHARES;
    machine.zfs_io_priority = ZFS_IO;
    machine.alias = randAlias();

    machine.brand = BRANDS[randNumber(BRANDS.length)];
    machine.state = STATUS[randNumber(STATUS.length)];

    machine.create_timestamp = date;
    machine.tags = JSON.stringify({});

    machine.internal_metadata = JSON.stringify({
        uuid: muuid
    });

    dn = sprintf(MACHINE_FMT, muuid, owner);

    ufds.add(dn, machine, function (err) {
        if (err)
            callback(err, machine);
        else
            callback(null, machine);
    });
}

module.exports = createMachine;
