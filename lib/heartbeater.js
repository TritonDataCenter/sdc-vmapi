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

    // Ths helps us find which vms are no longer on a server and
    // call ufds.updateVm
    this.lastSeenUuids = {};

    EventEmitter.call(this);

    this.connection = amqp.createConnection({ host: this.host });
    this.reconnectTimeout = options.reconnect * 1000;

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

    queue.on('open', function () {
        self.log.debug('Binded queue to exchange');
        queue.bind('heartbeat.*');

        queue.subscribeJSON(function (message, headers, deliveryInfo) {
            assert.object(message, 'amqp message');
            assert.string(deliveryInfo.routingKey, 'amqp routingKey');

            var serverUuid = deliveryInfo.routingKey.split('.')[1];

            if (!self.lastSeenUuids[serverUuid])
                self.lastSeenUuids[serverUuid] = [];

            var missing = self.getMissingUuids(serverUuid, message.zoneStatus);
            self.emit('heartbeat', serverUuid, message.zoneStatus, missing);
        });
    });
};



/*
 * Compares the new set of UUIDs with the previously cached. If there are
 * missing UUIDs we can assume the vm was destroyed and mark as destroyed
 * on UFDS.
 */
Heartbeater.prototype.getMissingUuids = function (server, hbs) {
    var uuids = [];
    var missing = [];

    hbs.forEach(function (hb) {
        var uuid = hb[1];
        if (uuid != 'global')
            uuids.push(uuid);
    });

    this.lastSeenUuids[server].forEach(function (uuid) {
        if (uuids.indexOf(uuid) == -1)
            missing.push(uuid);
    });

    this.lastSeenUuids[server] = uuids;

    return missing;
};



/*
 * Process each heartbeat. For each heartbeat we need to check if the vm
 * exists and create it on UFDS if they don't
 *
 * Sample heartbeat:
 *    ID   zonename  status
 *   [ 0, 'global', 'running', '/', '', 'liveimg', 'shared', '0'
 */
function processHeartbeats(vmapi, server, hbs, missing) {
    var self = this;

    for (var i = 0; i < hbs.length; i++) {
        processHeartbeat(vmapi, server, hbs[i]);
    }

    for (var i = 0; i < missing.length; i++) {
        processDestroyed(vmapi, missing[i]);
    }
}

Heartbeater.prototype.processHeartbeats = processHeartbeats;



/**
 * Call machine_load from CNAPI and with that result call UFDS.
 * A call to UFDS will result in an add or replace
 */
function cnapiThenUfds(vmapi, server, uuid) {
    vmapi.cnapi.getVm(server, uuid, function (err, vm) {
        if (err) {
            vmapi.log.error('Error talking to CNAPI', err);
        } else if (vm) {
            var m = common.translateVm(vm, true);
            vmapi.cache.setVm(uuid, m, function(cacheErr) {
                if (cacheErr) {
                    vmapi.log.error('Error caching VM', cacheErr);
                    return;
                }

                vmapi.ufds.addReplaceVm(m);
                vmapi.napi.addNics(m);
            });
        }
    });
}



/**
 * Processes a single heartbeat array item
 */
function processHeartbeat(vmapi, server, hb) {
    var uuid = hb[1];
    var zoneState = hb[2];
    var lastModified = new Date(hb[8]);

    if (uuid == 'global')
        return;

    vmapi.cache.getVm(uuid, function (cacheErr, oldVm) {
        if (cacheErr) {
            vmapi.log.error('Error getting VM from cache', cacheErr);
            return;
        }

        // If machine doesn't exist in cache, add it
        if (!oldVm) {
            cnapiThenUfds(vmapi, server, uuid);

        // If machine does exist in cache but its last_modified timestamp
        // is older than the lastModified timestamp of the heartbeat or
        // its state is different to the heartbeat state, then update cache
        } else {
            oldVm = common.translateVm(oldVm, true);
            var oldLastModified = new Date(oldVm['last_modified']);
            var oldZoneState = oldVm['zone_state'];

            if (oldZoneState != zoneState || oldLastModified < lastModified) {
                cnapiThenUfds(vmapi, server, uuid);
            }
        }
    });
}



/**
 * Processes a single heartbeat array item
 */
function processDestroyed(vmapi, uuid) {
    vmapi.cache.getVm(uuid, function (cacheErr, oldVm) {
        if (cacheErr) {
            vmapi.log.error('Error getting VM from cache', cacheErr);
            return;
        }

        if (oldVm) {
            oldVm = common.translateVm(oldVm, true);
            vmapi.napi.deleteNics(oldVm);
            vmapi.ufds.markAsDestroyed(vmapi.cache, oldVm, function (err) {
                if (err) {
                    vmapi.log.error('Error marking ' + oldVm.uuid +
                                    ' as destroyed on UFDS', err);
                } else {
                    vmapi.log.info('VM ' + oldVm.uuid +
                                  ' marked as destroyed on UFDS');
                }
            });
        }
    });
}

module.exports = Heartbeater;
