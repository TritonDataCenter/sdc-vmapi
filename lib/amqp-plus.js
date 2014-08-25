/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
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
        self.log.info('AMQP Ready');
        self.connecting = false;
        self.connected = true;

        clearTimeout(self.reconnectTimeout);
        clearInterval(self.reconnectionInterval);
        self.reconnectTimeout = null;
        self.reconnectionInterval = null;

    });

    self.on('error', function (e) {
        self.connecting = false;
        self.log.error(e, 'AMQP connection error');

        clearTimeout(self.reconnectTimeout);
        clearInterval(self.reconnectionInterval);
        self.reconnectTimeout = null;
        self.reconnectionInterval = null;

        self.reconnectionInterval = setInterval(function () {
            self.log.info('forcing reconnect');
            self.reconnect();
        }, 5000);
    });

    self.on('close', function (e) {
        self.log.info('AMQP Connection close');
        self.connecting = false;
        self.connected = false;

        clearTimeout(self.reconnectTimeout);
        clearInterval(self.reconnectionInterval);
        self.reconnectTimeout = null;
        self.reconnectionInterval = null;

        self.reconnectionInterval = setInterval(function () {
            self.log.info('Forcing reconnect');
            self.reconnect();
        }, 5000);
    });
}

util.inherits(Connection, amqp.Connection);

Connection.prototype.reconnect = function () {
    var self = this;

    clearTimeout(self.reconnectTimeout);
    clearInterval(self.reconnectionInterval);
    self.reconnectTimeout = null;
    self.reconnectionInterval = null;

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
