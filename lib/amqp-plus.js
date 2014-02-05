/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * AMQP connection wrapper.
 */

var amqp = require('amqp');
var util = require('util');

function Connection(connectionArgs, options) {
    var self = this;
    amqp.Connection.apply(this, arguments);

    if (options) {
        this.resource = options.resource;
        this.log = options.log;
    }

    this.connected = false;
    this.connecting = false;
    this.reconnectionInterval = null;
    this.reconnectTimeout = null;


    self.on('ready', function () {
        self.connecting = false;
        self.connected = true;

        clearTimeout(self.reconnectTimeout);
        clearInterval(self.reconnectionInterval);
        self.reconnectTimeout = null;
        self.reconnectionInterval = null;
    });

    self.on('error', function (e) {
        self.connecting = false;
        self.log.error(e, 'AMQP connection error:');
    });

    self.on('close', function (e) {
        var num = Math.floor(Math.random() * 1000);
        self.log.info('AMQP Connection close %s', num);
        self.connecting = false;
        self.connected = false;

        clearTimeout(self.reconnectTimeout);
        clearInterval(self.reconnectionInterval);
        self.reconnectTimeout = null;
        self.reconnectionInterval = null;

        switch (self.readyState) {
            case 'opening':
                if (self.reconnectionInterval || !e) {
                    break;
                }
                break;
            case 'closed':
                self.reconnectionInterval = setInterval(function () {
                    self.log.info('Forcing reconnect %s', num);
                    self.reconnect();
                }, 5000);
                break;
            default:
                break;
        }
    });
}

util.inherits(Connection, amqp.Connection);

Connection.prototype.reconnect = function () {
    var self = this;

    if (!self.reconnectTimeout && (self.connecting || self.connected)) {
        self.log.info('Was going to connect, but noticed ' +
            'we are connecting or already connected.');
        return;
    }

    self.connecting = true;
    self.log.info('Connecting to AMQP');

    self.reconnectTimeout = setTimeout(function () {
        self.log.error('Timed-out waiting for AMQP ready event');
        self.end();
        amqp.Connection.prototype.reconnect.apply(self, arguments);
    }, 4000);

    amqp.Connection.prototype.reconnect.apply(self, arguments);
};

function createConnection(connectionArgs, options) {
    var c = new Connection(connectionArgs, options);
    c.connect();
    return c;
}

module.exports = {
    Connection: Connection,
    createConnection: createConnection
};