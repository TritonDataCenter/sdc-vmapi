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
var SERVER_KEY = 'vmapi:servers:%s:vms';
var STATUS_KEY = 'vmapi:vms:status';


function Cache(options) {
    assert.object(options, 'redis options');
    assert.object(options.log, 'redis options.log');

    this.options = options;
    this.log = options.log;

    attemptConnect.call(this);
}


function attemptConnect() {
    var self = this;
    var log = this.log;
    var timeout = null;

    var client = this.client = redis.createClient(
        this.options.port || 6379,   // redis default port
        this.options.host || '127.0.0.1',
        { max_attempts: 1 });

    function onReady() {
        clearTimeout(timeout);
        timeout = null;

        // VMAPI's DB Index
        client.select(4);
        log.info('Redis client connected');
    }

    function onError(err) {
        log.error(err, 'Cache client error');
    }

    function onEnd() {
        client.end();
        self.client = null;
        log.error('Cache client disconnected');
        log.info('Re-attempting connection to Redis');

        if (!timeout) {
            attemptConnect.call(self);
        }
    }

    function timeoutCallback() {
        attemptConnect.call(self);
    }

    client.once('ready', onReady);
    client.on('error', onError);
    client.once('end', onEnd);

    timeout = setTimeout(timeoutCallback, 10000);
}


Cache.prototype.connected = function () {
    return this.client && this.client.connected;
};


Cache.prototype.set = function (hash, object, callback) {
    // ZAPI-163
    this.log.debug('Calling hmset with', hash, object);
    return this.client.hmset(hash, object, callback);
};



Cache.prototype.get = function (hash, callback) {
    return this.client.hgetall(hash, callback);
};



Cache.prototype.del = function (key, callback) {
    return this.client.del(key, callback);
};



Cache.prototype.getKey = function (hash, key, callback) {
    return this.client.hget(hash, key, callback);
};



Cache.prototype.getKeys = function (hash, callback) {
    return this.client.hkeys(hash, callback);
};



Cache.prototype.setKey = function (hash, key, value, callback) {
    return this.client.hset(hash, key, value, callback);
};



Cache.prototype.delKey = function (hash, key, callback) {
    return this.client.hdel(hash, key, callback);
};



Cache.prototype.getHashes = function (hashes, callback) {
    var multi = this.client.multi();

    for (var i = 0; i < hashes.length; i++) {
        multi.hgetall(hashes[i]);
    }

    multi.exec(callback);
};



Cache.prototype.exists = function (key, callback) {
    this.client.exists(key, callback);
};



/**
 * VM helper functions
 */


/*
 * Gets a list of VMs from a list of uuids
 */
Cache.prototype.getVms = function (uuids, callback) {
    assert.arrayOfString(uuids, 'VM UUIDs');

    var vmKeys = [];

    for (var i = 0; i < uuids.length; i++) {
        vmKeys.push(sprintf(VM_KEY, uuids[i]));
    }

    return this.getHashes(vmKeys, callback);
};



Cache.prototype.setVm = function (uuid, vm, callback) {
    var vmKey = sprintf(VM_KEY, uuid);
    var hash = common.vmToHash(vm);

    return this.set(vmKey, hash, callback);
};



Cache.prototype.getVm = function (uuid, callback) {
    var vmKey = sprintf(VM_KEY, uuid);

    return this.get(vmKey, callback);
};



Cache.prototype.getVmsForServer = function (server, callback) {
    var serverKey = sprintf(SERVER_KEY, server);

    return this.getKeys(serverKey, callback);
};



Cache.prototype.setVmsForServer = function (server, hash, callback) {
    var self = this;
    var serverKey = sprintf(SERVER_KEY, server);

    this.del(serverKey, function (err) {
        if (err) {
            callback(err);
            return;
        }

        self.set(serverKey, hash, callback);
    });
};



Cache.prototype.getState = function (uuid, callback) {
    return this.getKey(STATUS_KEY, uuid, callback);
};



Cache.prototype.setState = function (uuid, state, callback) {
    return this.setKey(STATUS_KEY, uuid, state, callback);
};



Cache.prototype.delState = function (uuid, callback) {
    return this.delKey(STATUS_KEY, uuid, callback);
};



Cache.prototype.setVmState =
    function (uuid, zoneState, timestamp, server, persisted, cb) {

    var self = this;
    var stateStamp;

    if (persisted) {
        stateStamp = zoneState + ';' + timestamp;
    } else {
        stateStamp = zoneState + ';' + timestamp + ';false';
    }

    var machineState = (zoneState == 'running' || zoneState == 'shutting_down')
                     ? 'running'
                     : 'stopped';

    function onSaveState(stateErr) {
        if (stateErr) {
            cb(stateErr);
            return;
        }

        self.getVm(uuid, onGetVm);
    }

    function onGetVm(readErr, cached) {
        if (readErr) {
            cb(readErr);
            return;
        }

        if (!cached) {
            cached = { uuid: uuid };
        }

        // The first time we see a zone its server_uuid is null because it
        // probably was automatically allocated by DAPI
        if (!cached['server_uuid']) {
            cached['server_uuid'] = server;
        }

        cached.state = machineState;
        cached['zone_state'] = stateStamp;

        self.setVm(uuid, common.translateVm(cached, false),
        function (writeErr) {
            if (writeErr) {
                cb(writeErr);
                return;
            }

            cb();
        });
    }

    self.setState(uuid, stateStamp, onSaveState);
};



Cache.prototype.existsVm = function (uuid, callback) {
    var vmKey = sprintf(VM_KEY, uuid);

    this.exists(vmKey, callback);
};


module.exports = Cache;
