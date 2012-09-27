/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var util = require('util');
var amqp = require('amqp');
var common = require('./common');
var assert = require('assert-plus');
var EventEmitter = require('events').EventEmitter;



/*
 * Heartbeater constructor. options is an object with the following properties:
 *  - host: AMQP host
 *  - queue: AMQP queue. Defaults to 'heartbeat.vmapi'
 *  - log: bunyan logger instance
 */
function Heartbeater(options) {
    assert.object(options, 'amqp options');
    assert.string(options.host, 'amqp options.host');

    this.host = options.host;
    this.queue = options.queue || 'heartbeat.vmapi';
    this.log = options.log;

    EventEmitter.call(this);

    this.connection = amqp.createConnection({ host: this.host });
    this.reconnectTimeout = (options.reconnect || 5) * 1000;

    this.connection.on('error', this.onError.bind(this));
    this.connection.on('ready', this.onReady.bind(this));
}

util.inherits(Heartbeater, EventEmitter);



/*
 * Reconnects to the AMQP host
 */
Heartbeater.prototype.reconnect = function () {
    this.connection.reconnect();
};



/*
 * On error gets called when a AMQP connection error is produced
 */
Heartbeater.prototype.onError = function (err) {
    var self = this;

    this.log.error('AMQP Connection Error ' + err.code +
                   ', re-trying in 5 seconds...');

    setTimeout(function () {
        self.reconnect();
    }, this.reconnectTimeout);
};



/*
 * On ready gets called when the connection to the AMQP was successfully
 * established. From here we can start using AMQP
 */
Heartbeater.prototype.onReady = function () {
    var self = this;
    var connection = self.connection;

    self.log.debug('Connected to AMQP');
    var queue = connection.queue(self.queue);

    function onQueueOpen() {
        self.log.debug('Binded queue to exchange');
        queue.bind('heartbeat.*');
        queue.subscribeJSON(onJson);
    }

    function onJson(message, headers, deliveryInfo) {
        assert.object(message, 'amqp message');
        assert.string(deliveryInfo.routingKey, 'amqp routingKey');

        var serverUuid = deliveryInfo.routingKey.split('.')[1];
        self.emit('heartbeat', serverUuid, message.zoneStatus);
    }

    queue.on('open', onQueueOpen);
};



/*
 * Array to hash
 */
function arrayToHash(array) {
    var hash = {};

    for (var i = 0; i < array.length; i++) {
        hash[array[i]] = 1;
    }

    return hash;
}



/*
 * Compares the new set of UUIDs with the previously cached. If there are
 * missing UUIDs we can assume the vm was destroyed and proceed to mark as
 * destroyed on UFDS. This function reads server-vms hash on redis, which holds
 * the last available list of active vms on a server.
 */
Heartbeater.prototype.getMissingUuids = function (cache, server, hbs, cb) {
    var self = this;
    var uuids = [];
    var missing = [];

    // Maps to an array of UUIDs currently active in the server
    hbs.forEach(function (hb) {
        var uuid = hb[1];
        if (uuid != 'global') {
            uuids.push(uuid);
        }
    });

    function onCache(err, cached) {
        if (err) {
            self.log.error('Could not get list of cached VM UUIDs for ' +
                'server %s', server);
            cb(err);
            return;
        }

        cached.forEach(function (uuid) {
            if (uuids.indexOf(uuid) == -1) {
                missing.push(uuid);
            }
        });

        var newHash = arrayToHash(uuids);

        cache.setVmsForServer(server, newHash, function(err) {
            onSaveCache(err, missing);
        });
    }

    function onSaveCache(err, missing){
        if (err) {
            self.log.error('Could not cache list VM UUIDs for ' +
                'server %s', server);
            cb(err);
            return;
        }

        cb(null, missing);
    }

    cache.getVmsForServer(server, onCache);
};



/*
 * Process each heartbeat. For each heartbeat we need to check if the vm
 * exists and create it on UFDS if they don't
 *
 * Sample heartbeat:
 *    ID   zonename  status
 *   [ 0, 'global', 'running', '/', '', 'liveimg', 'shared', '0'
 */
function processHeartbeats(vmapi, server, hbs) {
    var self = this;

    if (!vmapi.cache.connected()) {
        self.log.error('Cannot process heartbeats without connection to Redis');
        return;
    }

    for (var i = 0; i < hbs.length; i++) {
        processHeartbeat(vmapi, server, hbs[i]);
    }

    self.getMissingUuids(vmapi.cache, server, hbs, function(err, missing) {
        if (err) {
            self.log.error(err);
            return;
        }

        for (i = 0; i < missing.length; i++) {
            processDestroyed(vmapi, missing[i]);
        }
    });
}

Heartbeater.prototype.processHeartbeats = processHeartbeats;



/**
 * Call machine_load from CNAPI and with that result call UFDS.
 * A call to UFDS will result in an add or replace
 */
function cnapiThenUfds(vmapi, server, uuid) {
    vmapi.log.debug('Calling machine_load for VM %s', uuid);

    function onGetVm(err, vm) {
        if (err) {
            vmapi.log.error('Error talking to CNAPI', err);

        } else if (vm) {
            var m = common.translateVm(vm, false);

            function onSetVm(cacheErr) {
                if (cacheErr) {
                    vmapi.log.error('Error caching VM', cacheErr);
                    return;
                }

                vmapi.ufds.addUpdateVm(m);
                vmapi.napi.addNics(m);
            }

            vmapi.cache.setVm(uuid, m, onSetVm);
        }
    }

    vmapi.cnapi.getVm(server, uuid, onGetVm);
}



/**
 * Processes a single heartbeat array item
 */
function processHeartbeat(vmapi, server, hb) {
    var uuid = hb[1];
    var zoneState = hb[2];
    var lastModified = new Date(hb[8]);

    if (uuid == 'global') {
        return;
    }

    function onSetState(err) {
        if (err) {
            vmapi.log.error('Error caching VM state %s %s', uuid, err);
            return;
        }

        vmapi.log.debug('VM state cached %s %s %s', uuid, zoneState, hb[8]);
        cnapiThenUfds(vmapi, server, uuid);
    }

    function onGetState(err, state) {
        if (err) {
            vmapi.log.error('Error getting VM %s state from cache', uuid, err);
            return;
        }

        if (state) {
            var fields = state.split(';');
            var oldZoneState = fields[0];
            var oldLastModified = new Date(fields[1]);

            if (oldZoneState != zoneState || oldLastModified < lastModified) {
                updateState();
            }

        } else {
            updateState();
        }
    }

    function updateState() {
        vmapi.cache.setVmState(uuid, zoneState, hb[8], server, onSetState);
    }

    vmapi.cache.getState(uuid, onGetState);
}



/**
 * Processes a single heartbeat array item
 */
function processDestroyed(vmapi, uuid) {

    function onGetVm(cacheErr, oldVm) {
        if (cacheErr) {
            vmapi.log.error('Error getting VM from cache', cacheErr);
            return;
        }

        if (oldVm) {

            function onUfdsDestroyed(err) {
                if (err) {
                    vmapi.log.error('Error marking ' + oldVm.uuid +
                                    ' as destroyed on UFDS', err);
                } else {
                    vmapi.log.info('VM ' + oldVm.uuid +
                                  ' marked as destroyed on UFDS');
                }
            }

            function onStateDeleted(err) {
                if (err) {
                    vmapi.log.error('Error deleting ' + oldVm.uuid +
                                    ' state from cache', err);
                } else {
                    vmapi.log.info('VM ' + oldVm.uuid +
                                  ' state removed from cache');
                }
            }

            oldVm = common.translateVm(oldVm, true);
            vmapi.napi.deleteNics(oldVm);
            vmapi.ufds.markAsDestroyed(vmapi.cache, oldVm, onUfdsDestroyed);
            vmapi.cache.delState(oldVm.uuid, onStateDeleted);
        }
    }

    vmapi.cache.getVm(uuid, onGetVm);
}

module.exports = Heartbeater;
