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
  if (typeof(options) !== 'object')
    throw new TypeError('amqp options (Object) required');
  if (typeof(options.host) !== 'string')
    throw new TypeError('amqp host (String) required');

  this.host = options.host;
  this.queue = options.queue || 'heartbeat.zapi';
  this.log = options.log;

  EventEmitter.call(this);

  var self = this;
  var connection = this.connection = amqp.createConnection({ host: this.host });

  connection.on("error", function(err) {
    self.emit('connectionError', err);
  });

  connection.on('ready', function () {
    self.log.debug("Connected to AMQP")
    exchange = connection.exchange("amq.topic");
    var queue = connection.queue(self.queue);

    queue.on('open', function() {
      self.log.debug("Binded queue to exchange")
      queue.bind("heartbeat.#");

      queue.subscribeJSON(function(message) {
        // self.log.trace("Received heartbeat", message);
        assert(message.zoneStatus);
        self.emit('heartbeat', message.zoneStatus);
      });
    });
  });
}

util.inherits(Heartbeater, EventEmitter);

Heartbeater.prototype.reconnect = function() {
  this.connection.reconnect();
}

module.exports = Heartbeater;