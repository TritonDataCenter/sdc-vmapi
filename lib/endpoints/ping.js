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
    req.app.moray.ping(function (err) {
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
        var heartbeater = req.app.heartbeater;
        var cache = (req.app.cache.connected() === true) ? 'online' : 'offline';
        var hb = (heartbeater.lastError === null) ? 'online' : 'offline';
        var pingErrors;

        var services = {
            cache: cache,
            heartbeater: hb,
            moray: results.status
        };

        var healthy = true;
        var resStatus = 200;

        for (var name in services) {
            if (services[name] === 'offline') {
                healthy = false;
                resStatus = 503;
                req.app.status = req.app.statuses.NOT_CONNECTED;
                break;
            }
        }

        if (services.moray === 'offline') {
            pingErrors = { moray: results.error };
        } else {
            pingErrors = {};
        }

        var response = {
            pid: process.pid,
            status: req.app.status,
            healthy: healthy,
            services: services,
            pingErrors: pingErrors,
            lastHeartbeatError: heartbeater.lastError,
            lastHeartbeatReceived: heartbeater.lastReceived,
            lastHeartbeatProcessed: heartbeater.lastProcessed
        };

        res.send(resStatus, response);
        return next();
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
