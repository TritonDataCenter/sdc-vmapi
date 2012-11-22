/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var restify = require('restify');
var assert = require('assert');

var common = require('../common');



/*
 * Quickly ping CNAPI and NAPI and see if their HTTP servers are up
 */
function pingApis(req, callback) {
    var cnapi = 'online';
    var napi = 'online';

    req.cnapi.ping(function (err) {
        if (err) {
            cnapi = 'offline';
        }

        req.napi.ping(function (err2) {
            if (err2) {
                napi = 'offline';
            }

            callback({
                cnapi: cnapi,
                napi: napi
            });
        });
    });
}



/*
 * GET /ping
 */
function ping(req, res, next) {
    req.log.trace('Ping start');

    pingApis(req, function (apis) {
        var services = {
            redis: req.cache.connected() === true ? 'online' : 'offline',
            wfapi: req.wfapi.connected === true ? 'online' : 'offline',
            moray: req.moray.connected === true ? 'online' : 'offline',
            cnapi: apis.cnapi,
            napi: apis.napi
        };

        var status = {
            services: services,
            lastHeartbeatReceived: req.heartbeater.lastReceived,
            lastHeartbeatProcessed: req.heartbeater.lastProcessed
        };

        res.send(status);
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
