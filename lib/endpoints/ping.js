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

        return callback({ status: status, error: err && err.toString() });
    });
}



/*
 * GET /ping
 */
function ping(req, res, next) {
    pingMoray(req, function (results) {
        var heartbeater = req.app.heartbeater;
        var wfapi = (req.app.wfapi.connected === true) ? 'online' : 'offline';
        var pingErrors;

        var services = {
            moray: results.status,
            wfapi: wfapi
        };

        var response = {};

        if (!req.app.useVmAgent()) {
            var hb = (heartbeater.lastError === null) ? 'online' : 'offline';
            var cache = (req.app.cache.connected() === true) ? 'online' :
                                                               'offline';
            services.cache = cache;
            services.heartbeater = hb;

            response.lastHeartbeatError = heartbeater.lastError;
            response.lastHeartbeatReceived = heartbeater.lastReceived;
            response.lastHeartbeatProcessed = heartbeater.lastProcessed;
        }

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
            response.pingErrors = { moray: results.error };
        } else {
            response.pingErrors = {};
        }

        response.pid = process.pid;
        response.status = req.app.status;
        response.healthy = healthy;
        response.services = services;

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
