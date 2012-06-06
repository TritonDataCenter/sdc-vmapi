/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var util = require('util');
var amqp = require('amqp');
var assert = require('assert');
var common = require('./common');
var EventEmitter = require('events').EventEmitter;



/*
 * Heartbeater constructor. options is an object with the following properties:
 *  - host: AMQP host
 *  - queue: AMQP queue. Defaults to 'heartbeat.vmapi'
 *  - log: bunyan logger instance
 */
function Heartbeater(options) {
    if (typeof (options) !== 'object')
        throw new TypeError('amqp options (Object) required');
    if (typeof (options.host) !== 'string')
        throw new TypeError('amqp host (String) required');

    this.host = options.host;
    this.queue = options.queue || 'heartbeat.vmapi';
    this.log = options.log;
    // Ths array helps us find which vms are no longer on a server and
    // call ufds.updateVm
    this.lastSeenUuids = [];

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
            assert(message);
            assert(deliveryInfo.routingKey);

            var serverUuid = deliveryInfo.routingKey.split('.')[1];
            var missing = self.getMissingUuids(message.zoneStatus);

            self.emit('heartbeat', serverUuid, message.zoneStatus, missing);
        });
    });
};



/*
 * Compares the new set of UUIDs with the previously cached. If there are
 * missing UUIDs we can assume the vm was destroyed and mark as destroyed
 * on UFDS.
 */
Heartbeater.prototype.getMissingUuids = function (hbs) {
    var uuids = [];
    var missing = [];

    hbs.forEach(function (hb) {
        var uuid = hb[1];
        if (uuid != 'global')
            uuids.push(uuid);
    });

    this.lastSeenUuids.forEach(function (uuid) {
        if (uuids.indexOf(uuid) == -1)
            missing.push(uuid);
    });

    this.lastSeenUuids = uuids;

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
    var ufds = vmapi.ufds;
    var napi = vmapi.napi;
    var cnapi = vmapi.cnapi;
    var cache = vmapi.cache;

    // Call machine_load from CNAPI and with that result call UFDS.
    // A call to UFDS will result in an add or replace
    function cnapiThenUfds(auuid) {
        cnapi.getVm(server, auuid, function (err, vm) {
            if (err) {
                self.log.error('Error talking to CNAPI', err);
            } else {
                var m = common.translateVm(vm, true);
                cache.set(auuid, m);
                ufds.addReplaceVm(m);
                napi.addNics(m);
            }
        });
    }

    // * When self.cache.get returns nothing it means that we need to check on
    //   UFDS if the vm exists and either add it or replace it
    //
    // * When self.cache.get returns a vm we need to check two things:
    //   - Was this a status change only? Update vm status on UFDS
    //   - Was this a zone xml change? Replace vm on UFDS
    for (var i = 0; i < hbs.length; i++) {
        var hb = hbs[i];
        var uuid = hb[1];
        var zone_state = hb[2];
        var lastModified = new Date(hb[8]);

        if (uuid != 'global') {
            var oldVm = cache.get(uuid);

            if (!oldVm) {
                cnapiThenUfds(uuid);
            }

            if (oldVm &&
                ((oldVm.zone_state != zone_state) ||
                    (new Date(oldVm.last_modified) < lastModified))) {
                cnapiThenUfds(uuid);
            }
        }
    }

    for (var i = 0; i < missing.length; i++) {
        var oldVm = cache.get(missing[i]);

        if (oldVm) {
            ufds.markAsDestroyed(cache, oldVm, function (err) {
                if (err) {
                    self.log.error('Error marking ' + oldVm.uuid +
                                    ' as destroyed on UFDS', err);
                } else {
                    self.log.info('VM ' + oldVm.uuid +
                                  ' marked as destroyed on UFDS');
                }
            });
        }
    }
}

Heartbeater.prototype.processHeartbeats = processHeartbeats;



module.exports = Heartbeater;
