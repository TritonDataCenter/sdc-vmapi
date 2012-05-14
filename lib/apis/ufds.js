/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Main entry-point for the Zones API.
 */

var UFDS = require('sdc-clients').UFDS;
var EventEmitter = require('events').EventEmitter;
var sprintf = require('sprintf').sprintf;
var assert = require('assert');
var restify = require('restify');
var util = require('util');

var common = require('./../common');

var SUFFIX = 'o=smartdc';

var USERS = 'ou=users, ' + SUFFIX;
var USER_FMT = 'uuid=%s, ' + USERS;
var MACHINE_FMT = 'machine=%s, ' + USER_FMT;



/*
 * UFDS Constructor
 */
function Ufds(options) {
    this.log = options.log;
    this.connection = new UFDS(options);
    // this.connection.setLogLevel(options.logLevel);

    EventEmitter.call(this);

    var self = this;

    this.connection.on('ready', function () {
        self.emit('ready');
    });

    this.connection.on('error', function (err) {
        self.emit('error', err);
    });
}

util.inherits(Ufds, EventEmitter);



/*
 * LDAP Search
 */
Ufds.prototype.search = function (base, options, callback) {
    return this.connection.search(base, options, callback);
};



/*
 * LDAP Add
 */
Ufds.prototype.add = function (dn, entry, callback) {
    return this.connection.add(dn, entry, callback);
};



/*
 * LDAP Del
 */
Ufds.prototype.del = function (dn, callback) {
    return this.connection.del(dn, callback);
};



/*
 * Adds a machine on UFDS. This function expects a cnapi-like machine object.
 * This object is converted to a UFDS like machine schema
 */
Ufds.prototype.addMachine = function (machine, callback) {
    var dn = sprintf(MACHINE_FMT, machine.uuid, machine.owner_uuid);

    var newMachine = common.machineToUfds(machine);
    delete newMachine.owner_uuid;
    newMachine.objectclass = 'machine';

    this.connection.add(dn, newMachine, function (err) {
        if (err) {
            callback(err);
        } else {
            callback(null);
        }
    });
};



/*
 * Updates a machine on UFDS. This function expects a cnapi-like machine object.
 * This object is converted to a UFDS like machine schema. For now this function
 * is doing a complete replace of the machine object properties
 */
Ufds.prototype.replaceMachine = function (machine, callback) {
    var dn = sprintf(MACHINE_FMT, machine.uuid, machine.owner_uuid);

    var newMachine = common.machineToUfds(machine);
    delete newMachine.owner_uuid;

    var operation = {
        type: 'replace',
        modification: newMachine
    };

    this.connection.modify(dn, operation, function (err) {
        if (err)
          callback(err);
        else
          callback(null);
    });
};



/*
 * Updates machine attributes on UFDS. This is explicitly called by objects
 * providing a UFDS-like machine
 */
Ufds.prototype.updateMachine = function (machine, params, callback) {
    var dn = sprintf(MACHINE_FMT, machine.uuid, machine.owner_uuid);

    var operation = {
        type: 'replace',
        modification: params
    };

    this.connection.modify(dn, operation, function (err) {
        if (err)
          callback(err);
        else
          callback(null);
    });
};



/*
 * Deletes a machine from UFDS
 */
Ufds.prototype.deleteMachine = function (machine, callback) {
    var dn = sprintf(MACHINE_FMT, machine.uuid, machine.owner_uuid);

    this.connection.del(dn, function (err) {
        if (err)
          callback(err);
        else
          callback(null);
    });
};



/*
 * Adds or 'updates' a machine on UFDS. Currently it is completely replacing the
 * machine attributes but it will only update attributes that have changed
 */
Ufds.prototype.addReplaceMachine = function (machine) {
    var self = this;
    var log = this.log;

    var params = {
        uuid: machine.uuid,
        owner_uuid: machine.owner_uuid
    };

    function add() {
        self.addMachine(machine, function (err) {
            if (err)
                log.error('Could not create machine on UFDS', err);
            else
                log.debug('Added machine ' + machine.uuid + ' to UFDS');
        });
    }

    function replace() {
        self.replaceMachine(machine, function (err) {
            if (err)
                log.error('Could not update machine on UFDS', err);
            else
                log.debug('Machine updated ' + machine.uuid + ' on UFDS');
        });
    }

    self.getMachine(params, function (err, m) {
        if (err)
            log.error('Error getting machine info from UFDS', err);

        if (m)
            replace();
        else
            add();
    });
};



/*
 * Gets a machine from UFDS. When a machine is found, the second argument will
 * have an object, otherwise it will be null
 */
Ufds.prototype.getMachine = function (params, callback) {
    var baseDn;
    var uuid = params.uuid;
    var owner_uuid = params.owner_uuid;

    if (!common.validUUID(uuid))
        return callback(
          new restify.ConflictError('Machine UUID is not a valid UUID'));

    if (owner_uuid) {
        if (!common.validUUID(owner_uuid))
            return callback(
              new restify.ConflictError('Owner UUID is not a valid UUID'));

        baseDn = sprintf(USER_FMT, owner_uuid);
    } else {
        baseDn = USERS;
    }

    var options = {
        scope: 'sub',
        filter: '(&(objectclass=machine)(uuid=' + uuid + '))'
    };

    return this.connection.search(baseDn, options, function (err, items) {
        if (err)
            return callback(err);

        if (items.length == 0)
            return callback(null, null);
        else
            return callback(null, common.translateMachine(items[0], true));
    });
};



/*
 * Gets a list of machines from UFDS. When no machines are found the second
 * argument to the callback will have an empty array
 */
Ufds.prototype.listMachines = function (params, callback) {
    var baseDn;
    var owner_uuid = params.owner_uuid;
    var filter = '';

    if (owner_uuid) {
        if (!common.validUUID(owner_uuid))
            return callback(
              new restify.ConflictError('Owner UUID is not a valid UUID'),
                                        null);

        baseDn = sprintf(USER_FMT, owner_uuid);
    } else {
        baseDn = USERS;
    }

    if (params.brand)
        filter += '(brand=' + params.brand + ')';

    if (params.alias)
        filter += '(alias=' + params.alias + ')';

    if (params.state) {
        if (params.state == 'active')
            filter += '(!(state=destroyed))';
        else
            filter += '(state=' + params.state + ')';
    }

    if (params.ram)
        filter += '(ram=' + params.ram + ')';

    if (params.server_uuid)
        filter += '(server_uuid=' + params.server_uuid + ')';

    if (params.dataset_uuid)
        filter += '(dataset_uuid=' + params.dataset_uuid + ')';

    var options = {
        scope: 'sub',
        filter: '(&(objectclass=machine)(uuid=*)' + filter + ')'
    };

    return this.connection.search(baseDn, options, function (err, items) {
        if (err)
            return callback(err, null);

        var machines = [];

        for (var i = 0; i < items.length; i++)
            machines.push(common.translateMachine(items[i], true));

        return callback(null, machines);
    });
};



/*
 * Adds metadata to a machine on UFDS. mdataKey can be 'customer_metadata',
 * 'internal_metadata' or 'tags'.
 */
Ufds.prototype.addMetadata = function (machine, mdataKey, params, callback) {
    var mdata = common.clone(machine[mdataKey]);
    var numMetadata = 0;

    Object.keys(params).forEach(function (key) {
        if (key != 'uuid' && key != 'owner_uuid' && key != 'metadata') {
            mdata[key] = params[key];
            numMetadata++;
        }
    });

    if (numMetadata == 0) {
        return callback(
          new restify.InvalidArgumentError('At least one ' + mdataKey +
          ' key must be provided'),
          null);
    }

    var updateParams = {};
    updateParams[mdataKey] = JSON.stringify(mdata);

    return this.updateMachine(machine, updateParams, function (err) {
        if (err)
            return callback(err);

        return callback(null, mdata);
    });
};



/*
 * Deletes machine metadata from UFDS
 */
Ufds.prototype.deleteMetadata = function (machine, mdataKey, key, callback) {
    var mdata = common.clone(machine[mdataKey]);

    delete mdata[key];

    var updateParams = {};
    updateParams[mdataKey] = JSON.stringify(mdata);

    this.updateMachine(machine, updateParams, function (err) {
        if (err)
            return callback(err);

        return callback(null);
    });
};



/*
 * Deletes all metadata for a machine on UFDS
 */
Ufds.prototype.deleteMetadata = function (machine, mdataKey, callback) {
    var updateParams = {};
    updateParams[mdataKey] = [];

    this.updateMachine(machine, updateParams, function (err) {
        if (err)
            return callback(err);

        return callback(null);
    });
};




module.exports = Ufds;
