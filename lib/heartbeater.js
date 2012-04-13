/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var util = require('util');
var amqp = require('amqp');
var assert = require('assert');
var EventEmitter = require('events').EventEmitter;



/*
 * Heartbeater constructor. options is an object with the following properties:
 *  - host: AMQP host
 *  - queue: AMQP queue. Defaults to 'heartbeat.zapi'
 *  - log: bunyan logger instance
 */
function Heartbeater(options) {
    if (typeof (options) !== 'object')
        throw new TypeError('amqp options (Object) required');
    if (typeof (options.host) !== 'string')
        throw new TypeError('amqp host (String) required');

    this.host = options.host;
    this.queue = options.queue || 'heartbeat.zapi';
    this.log = options.log;

    EventEmitter.call(this);

    this.connection = amqp.createConnection({ host: this.host });
    this.reconnectTimeout = options.reconnect * 1000;

    this.connection.on('error', this.onError.bind(this));
    this.connection.on('ready', this.onReady.bind(this));
}

util.inherits(Heartbeater, EventEmitter);



Heartbeater.prototype.reconnect = function () {
    this.connection.reconnect();
}



Heartbeater.prototype.onError = function (err) {
    var self = this;

    this.log.error('AMQP Connection Error ' + err.code +
                   ', re-trying in 5 seconds...');

    setTimeout(function () {
        self.reconnect();
    }, this.reconnectTimeout);
}



Heartbeater.prototype.onReady = function () {
    var self = this;
    var connection = self.connection;

    self.log.debug('Connected to AMQP')
    exchange = connection.exchange('amq.topic');
    var queue = connection.queue(self.queue);

    queue.on('open', function () {
        self.log.debug('Binded queue to exchange')
        queue.bind('heartbeat.*');

        queue.subscribeJSON(function (message, headers, deliveryInfo) {
            assert(message);
            assert(deliveryInfo.routingKey);

            var serverUuid = deliveryInfo.routingKey.split('.')[1];
            self.emit('heartbeat', serverUuid, message.zoneStatus);
        });
    });
}


module.exports = Heartbeater;
