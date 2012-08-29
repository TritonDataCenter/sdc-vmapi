/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Cache client wrapper.
 */

var assert = require('assert-plus');
var redis = require('redis');
var sprintf = require('util').format;

var common = require('./common');

var VM_KEY = 'vmapi:vms:%s';
var STATUS_KEY = 'vmapi:vms:status';


function Cache(options) {
    assert.object(options, 'redis options');
    assert.object(options.log, 'redis options.log');

    var log = this.log = options.log;

    var client = this.client = new redis.createClient(
        options.port || 6379,   // redis default port
        options.host || '127.0.0.1',
        { max_attempts: 1 });

    client.on('error', function (err) {
        log.info(err, 'Cache client error');
    });

    client.on('end', function () {
        log.info('Cache client end, recycling it');
        client.end();
        client = null;
    });

    // VMAPI's DB Index
    client.select(4);
}



Cache.prototype.set = function(hash, object, callback) {
    return this.client.hmset(hash, object, callback);
};



Cache.prototype.get = function(hash, callback) {
    return this.client.hgetall(hash, callback);
};



Cache.prototype.getKey = function(hash, key, callback) {
    return this.client.hget(hash, key, callback);
};



Cache.prototype.setKey = function(hash, key, value, callback) {
    return this.client.hset(hash, key, value, callback);
};



Cache.prototype.delKey = function(hash, key, callback) {
    return this.client.hdel(hash, key, callback);
};



Cache.prototype.getHashes = function(hashes, callback) {
    var multi = this.client.multi();

    for (var i = 0; i < hashes.length; i++)
        multi.hgetall(hashes[i]);

    return multi.exec(callback);
};



Cache.prototype.exists = function(key, callback) {
    return this.client.exists(key, callback);
};



/**
 * VM helper functions
 */


/*
 * Gets a list of VMs from a list of uuids
 */
Cache.prototype.getVms = function(uuids, callback) {
    assert.arrayOfString(uuids, 'VM UUIDs');

    var vmKeys = [];

    for (var i = 0; i < uuids.length; i++)
        vmKeys.push(sprintf(VM_KEY, uuids[i]));

    return this.getHashes(vmKeys, callback);
};



Cache.prototype.setVm = function(uuid, vm, callback) {
    var vmKey = sprintf(VM_KEY, uuid);
    var hash = common.vmToHash(vm);

    return this.set(vmKey, hash, callback);
};



Cache.prototype.getVm = function(uuid, callback) {
    var vmKey = sprintf(VM_KEY, uuid);

    return this.get(vmKey, callback);
};



Cache.prototype.getState = function(uuid, callback) {
    return this.getKey(STATUS_KEY, uuid, callback);
};



Cache.prototype.setState = function(uuid, state, callback) {
    return this.setKey(STATUS_KEY, uuid, state, callback);
};



Cache.prototype.delState = function(uuid, callback) {
    return this.delKey(STATUS_KEY, uuid, callback);
};



Cache.prototype.setVmState = function(uuid, zoneState, timestamp, server, cb) {
    var self = this;
    var stateStamp = zoneState + ';' + timestamp;

    var machineState = (zoneState == 'running' || zoneState == 'shutting_down')
                     ? 'running'
                     : 'stopped';

    function onSaveState(stateErr) {
        if (stateErr)
            return cb(stateErr);

        return self.getVm(uuid, onGetVm);
    }

    function onGetVm(readErr, cached) {
        if (readErr)
            return cb(readErr);

        if (!cached)
            cached = { uuid: uuid, server_uuid: server };

        cached.state = machineState;
        cached['zone_state'] = stateStamp;

        self.setVm(uuid, common.translateVm(cached, false), function (writeErr) {
            if (writeErr)
                return cb(writeErr);

            return cb();
        });
    }

    self.setState(uuid, stateStamp, onSaveState);
};



Cache.prototype.existsVm = function(uuid, callback) {
    var vmKey = sprintf(VM_KEY, uuid);

    return this.exists(vmKey, callback);
};


module.exports = Cache;
