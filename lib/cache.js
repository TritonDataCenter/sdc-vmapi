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



Cache.prototype.set = function(key, object, callback) {
    return this.client.hmset(key, object, callback);
};



Cache.prototype.get = function(key, callback) {
    return this.client.hgetall(key, callback);
};



Cache.prototype.exists = function(key, callback) {
    return this.client.exists(key, callback);
};



/**
 * VM helper functions
 */

Cache.prototype.setVm = function(uuid, vm, callback) {
    var vmKey = sprintf(VM_KEY, uuid);
    var hash = common.vmToHash(vm);

    return this.set(vmKey, hash, callback);
};



Cache.prototype.getVm = function(uuid, callback) {
    var vmKey = sprintf(VM_KEY, uuid);

    return this.get(vmKey, callback);
};



Cache.prototype.existsVm = function(uuid, callback) {
    var vmKey = sprintf(VM_KEY, uuid);

    return this.exists(vmKey, callback);
};


module.exports = Cache;
