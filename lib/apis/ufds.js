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

var common = require('./../common');

var SUFFIX = 'o=smartdc';

var USERS = 'ou=users, ' + SUFFIX;
var USER_FMT = 'uuid=%s, ' + USERS;
var MACHINE_FMT = 'uuid=%s, ' + USER_FMT;



/*
 * UFDS Constructor
 */
function Ufds(options) {
    this.connection = new UFDS(options);
    this.connection.setLogLevel(options.logLevel);

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
}



/*
 * LDAP Add
 */
Ufds.prototype.add = function (dn, entry, callback) {
    return this.connection.add(dn, entry, callback);
}



/*
 * LDAP Del
 */
Ufds.prototype.del = function (dn, callback) {
    return this.connection.del(dn, callback);
}



/*
 * Adds a machine on UFDS. This function expects a cnapi-like machine object.
 * This object is converted to a UFDS like machine schema
 */
Ufds.prototype.addMachine = function (machine, callback) {
    var dn = sprintf(MACHINE_FMT, machine.uuid, machine.owner_uuid);

    var newMachine = common.machineToUfds(machine);
    newMachine.objectclass = 'machine';

    this.connection.add(dn, newMachine, function (err) {
        if (err)
          callback(err);
        else
          callback(null);
    });
}



/*
 * Updates a machine on UFDS. This function expects a cnapi-like machine object.
 * This object is converted to a UFDS like machine schema. For now this function
 * is doing a complete replace of the machine object properties
 */
Ufds.prototype.updateMachine = function (machine, callback) {
    var dn = sprintf(MACHINE_FMT, machine.uuid, machine.owner_uuid);

    var newMachine = common.machineToUfds(machine);

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
}



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

    this.connection.search(baseDn, options, function (err, items) {
        if (err)
            return callback(err);

        if (items.length == 0)
            return callback(null, null);
        else
            return callback(null, items[0]);
    });
}



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

    if (params.status)
        filter += '(status=' + params.status + ')';

    if (params.ram)
        filter += '(ram=' + params.ram + ')';

    var options = {
        scope: 'sub',
        filter: '(&(objectclass=machine)' + filter + ')'
    };

    this.connection.search(baseDn, options, function (err, items) {
        if (err)
            return callback(err, null);

        var machines = [];

        for (var i = 0; i < items.length; i++)
            machines.push(common.translateMachine(items[i]));

        return callback(null, machines);
    });
}



/*
 * Gets a list of machine tags from UFDS. When no tags are found the second
 * argument to the callback will have an empty array
 */
Ufds.prototype.listTags = function (machine, callback) {
    var baseDn = machine.dn;

    var options = {
        scope: 'sub',
        filter: '(objectclass=tag)'
    };

    this.connection.search(baseDn, options, function (err, items) {
        if (err)
            return callback(err, null);

        var tags = {};

        for (var i = 0; i < items.length; i++)
            tags[items[i].key] = items[i].value;

        return callback(null, tags);
    });
}



/*
 * Gets a machine tag from UFDS. When a tag is found, the second argument will
 * have an object, otherwise it will be null
 */
Ufds.prototype.getTag = function (machine, key, callback) {
    var baseDn = machine.dn;

    var options = {
        scope: 'sub',
        filter: '(&(objectclass=tag)(key=' + key + '))'
    };

    this.connection.search(baseDn, options, function (err, items) {
        if (err)
            return callback(err, null);

        return callback(null, items[0]);
    });
}



/*
 * Adds tags to a machine on UFDS.
 */
Ufds.prototype.addTags = function (machine, params, callback) {
    var tags = {};

    Object.keys(params).forEach(function (key) {
        if (key != 'uuid')
            tags[key] = params[key];
    });

    var keys = Object.keys(tags);
    var added = 0;

    if (!keys.length)
        return callback(
          new restify.InvalidArgumentError('At least one tag must be provided'),
          null);


    for (var i = 0; i < keys.length; i++) {
        var baseDn = 'tagkey=' + keys[i] + ', ' + machine.dn;

        var tag = {
            key: keys[i],
            value: tags[keys[i]],
            objectclass: 'tag'
        };

        this.connection.add(baseDn, tag, function (err) {
            if (err)
                return callback(err, null);

            added++;

            if (added == keys.length) {
                return callback(null, tags);
            }
        });
    }
}



/*
 * Deletes a machine tag from UFDS
 */
Ufds.prototype.deleteTag = function (tag, callback) {
    this.connection.del(tag.dn, function (err) {
        if (err)
            return callback(err);

        return callback(null);
    });
}



/*
 * Deletes all tags for a machine on UFDS
 */
Ufds.prototype.deleteTags = function (machine, callback) {
    var self = this;
    var baseDn = machine.dn;

    var options = {
        scope: 'sub',
        filter: '(objectclass=tag)'
    };

    this.connection.search(baseDn, options, function (err, items) {
        if (err)
            return callback(err);

        if (!items.length) {
            return callback(null);
        }

        var deleted = 0;

        for (var i = 0; i < items.length; i++) {
            var tag = items[i];

            self.connection.del(tag.dn, function (err) {
                if (err)
                    return callback(err);

                deleted++;

                if (deleted == items.length)
                    return callback(null);
            });
        }
    });
}




module.exports = Ufds;