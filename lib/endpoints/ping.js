/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var restify = require('restify');
var assert = require('assert');
var async = require('async');

var common = require('../common');



/*
 * For now just ping moray
 */
function pingMoray(req, callback) {
    req.moray.ping(function (err) {
        var status;

        if (err) {
            req.log.error(err, 'Error while pinging moray');
            status = 'offline';
        } else {
            status = 'online';
        }

        return callback({ status: status, error: err });
    });
}



/*
 * GET /ping
 */
function ping(req, res, next) {
    pingMoray(req, function (results) {
        var redis = (req.cache.connected() === true) ? 'online' : 'offline';
        var hb = (req.heartbeater.lastError === null) ? 'online' : 'offline';
        var pingErrors;

        var services = {
            redis: redis,
            heartbeater: hb,
            moray: results.status
        };

        var healthy = true;
        var status = 200;

        for (var name in services) {
            if (services[name] === 'offline') {
                healthy = false;
                status = 503;
                break;
            }
        }

        if (services.moray === 'offline') {
            pingErrors = { moray: results.error };
        } else {
            pingErrors = {};
        }

        var response = {
            healthy: healthy,
            services: services,
            pingErrors: pingErrors,
            lastHeartbeatError: req.heartbeater.lastError,
            lastHeartbeatReceived: req.heartbeater.lastReceived,
            lastHeartbeatProcessed: req.heartbeater.lastProcessed
        };

        res.send(status, response);
    });
}



/*
 * Mounts job actions as server routes
 */
function mount(server, before) {
    server.get({ path: '/ping', name: 'Ping' }, before, ping);
}


// --- Exports

module.exports = {
    mount: mount
};
