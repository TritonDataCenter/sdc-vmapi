/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Main entry-point for the VMs API.
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
var VM_FMT = 'vm=%s, ' + USER_FMT;



/*
 * UFDS Constructor
 */
function Ufds(options) {
    this.log = options.log;
    this.connection = new UFDS(options);

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
 * Adds a vm on UFDS. This function expects a cnapi-like vm object.
 * This object is converted to a UFDS like vm schema
 */
Ufds.prototype.addVm = function (vm, callback) {
    var dn = sprintf(VM_FMT, vm.uuid, vm.owner_uuid);

    var newVm = common.vmToUfds(vm);
    delete newVm.owner_uuid;
    newVm.objectclass = 'vm';

    this.connection.add(dn, newVm, function (err) {
        if (err) {
            callback(err);
        } else {
            callback(null);
        }
    });
};



/*
 * Updates a vm on UFDS. This function expects a cnapi-like vm object.
 * This object is converted to a UFDS like vm schema. For now this function
 * is doing a complete replace of the vm object properties
 */
Ufds.prototype.replaceVm = function (vm, callback) {
    var dn = sprintf(VM_FMT, vm.uuid, vm.owner_uuid);

    var newVm = common.vmToUfds(vm);
    delete newVm.owner_uuid;

    var operation = {
        type: 'replace',
        modification: newVm
    };

    this.connection.modify(dn, operation, function (err) {
        if (err)
          callback(err);
        else
          callback(null);
    });
};



/*
 * Updates vm attributes on UFDS. This is explicitly called by objects
 * providing a UFDS-like vm
 */
Ufds.prototype.updateVm = function (vm, params, callback) {
    var dn = sprintf(VM_FMT, vm.uuid, vm.owner_uuid);

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
 * Deletes a vm from UFDS
 */
Ufds.prototype.deleteVm = function (vm, callback) {
    var dn = sprintf(VM_FMT, vm.uuid, vm.owner_uuid);

    this.connection.del(dn, function (err) {
        if (err)
          callback(err);
        else
          callback(null);
    });
};



/*
 * Adds or 'updates' a vm on UFDS. Currently it is completely replacing the
 * vm attributes but it will only update attributes that have changed
 */
Ufds.prototype.addReplaceVm = function (vm) {
    var self = this;
    var log = this.log;

    var params = {
        uuid: vm.uuid,
        owner_uuid: vm.owner_uuid
    };

    function add() {
        self.addVm(vm, function (err) {
            if (err)
                log.error('Could not create vm on UFDS', err);
            else
                log.debug('Added vm ' + vm.uuid + ' to UFDS');
        });
    }

    function replace() {
        self.replaceVm(vm, function (err) {
            if (err)
                log.error('Could not update vm on UFDS', err);
            else
                log.debug('VM updated ' + vm.uuid + ' on UFDS');
        });
    }

    self.getVm(params, function (err, m) {
        if (err)
            log.error('Error getting vm info from UFDS', err);

        if (m)
            replace();
        else
            add();
    });
};



/*
 * Gets a vm from UFDS. When a vm is found, the second argument will
 * have an object, otherwise it will be null
 */
Ufds.prototype.getVm = function (params, callback) {
    var baseDn;
    var uuid = params.uuid;
    var owner_uuid = params.owner_uuid;

    if (!common.validUUID(uuid))
        return callback(
          new restify.InvalidArgumentError('VM UUID is not a valid UUID'));

    if (owner_uuid) {
        if (!common.validUUID(owner_uuid))
            return callback(
              new restify.InvalidArgumentError('Owner UUID is not a valid UUID'));

        baseDn = sprintf(USER_FMT, owner_uuid);
    } else {
        baseDn = USERS;
    }

    var options = {
        scope: 'sub',
        filter: '(&(objectclass=vm)(uuid=' + uuid + '))'
    };

    return this.connection.search(baseDn, options, function (err, items) {
        if (err)
            return callback(err);

        if (items.length == 0)
            return callback(null, null);
        else
            return callback(null, common.translateVm(items[0], true));
    });
};



/*
 * Gets a list of vms from UFDS. When no vms are found the second
 * argument to the callback will have an empty array
 */
Ufds.prototype.listVms = function (params, callback) {
    var baseDn;
    var owner_uuid = params.owner_uuid;
    var filter = '';

    if (owner_uuid) {
        if (!common.validUUID(owner_uuid))
            return callback(
              new restify.InvalidArgumentError('Owner UUID is not a valid UUID'));

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

    if (params.image_uuid)
        filter += '(image_uuid=' + params.image_uuid + ')';


    filter = common.addTagsFilter(params, filter);

    var options = {
        scope: 'sub',
        filter: '(&(objectclass=vm)(uuid=*)' + filter + ')'
    };

    return this.connection.search(baseDn, options, function (err, items) {
        if (err)
            return callback(err, null);

        var vms = [];

        for (var i = 0; i < items.length; i++)
            vms.push(common.translateVm(items[i], true));

        return callback(null, vms);
    });
};



/*
 * Marks a vm as destroyed
 */
Ufds.prototype.markAsDestroyed = function (cache, vm, callback) {
    var self = this;

    function cacheMarkAsDestroyed(m) {
        var params = {
            state: 'destroyed',
            zone_state: 'destroyed',
            destroyed: new Date()
        };

        m.state = params.state;
        m.zone_state = params.zone_state;
        m.destroyed = params.destroyed;
        cache.setVm(m.uuid, m, function (err) {
            if (err)
                self.log.error('Could not mark VM as destroyed in cache', err);
        });

        return params;
    }

    var params = cacheMarkAsDestroyed(vm);

    self.updateVm(vm, params, function (err) {
        if (err)
            return callback(err);

        return callback(null);
    });
};



/*
 * Adds metadata to a vm on UFDS. mdataKey can be 'customer_metadata',
 * 'internal_metadata' or 'tags'.
 */
Ufds.prototype.addMetadata = function (vm, mdataKey, params, callback) {
    var mdata = common.clone(vm[mdataKey]);
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

    return this.updateVm(vm, updateParams, function (err) {
        if (err)
            return callback(err);

        return callback(null, mdata);
    });
};



/*
 * Deletes vm metadata from UFDS
 */
Ufds.prototype.deleteMetadata = function (vm, mdataKey, key, callback) {
    var mdata = common.clone(vm[mdataKey]);

    delete mdata[key];

    var updateParams = {};
    updateParams[mdataKey] = JSON.stringify(mdata);

    this.updateVm(vm, updateParams, function (err) {
        if (err)
            return callback(err);

        return callback(null);
    });
};



/*
 * Deletes all metadata for a vm on UFDS
 */
Ufds.prototype.deleteMetadata = function (vm, mdataKey, callback) {
    var updateParams = {};
    updateParams[mdataKey] = [];

    this.updateVm(vm, updateParams, function (err) {
        if (err)
            return callback(err);

        return callback(null);
    });
};




module.exports = Ufds;
