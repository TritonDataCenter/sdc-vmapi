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
 * Quickly ping CNAPI and NAPI and see if their HTTP servers are up
 */
function pingApis(req, callback) {
    var cnapi = 'online';
    var napi = 'online';

    async.parallel({
        cnapi: pingCnapi,
        napi: pingNapi,
        moray: pingMoray
    }, afterParallel);

    function pingCnapi(cb) {
        req.cnapi.ping(function (err) {
            if (err) {
                return cb(err);
            } else {
                return cb(null, 'online');
            }
        });
    }

    function pingNapi(cb) {
        req.napi.ping(function (err) {
            if (err) {
                return cb(err);
            } else {
                return cb(null, 'online');
            }
        });
    }

    function pingMoray(cb) {
        req.moray.ping(function (err) {
            if (err) {
                return cb(err);
            } else {
                return cb(null, 'online');
            }
        });
    }

    function afterParallel(err, results) {
        if (err) {
            req.log.error(err, 'Error while pinging services');
        }

        return callback(results);
    }
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
            moray: apis.moray || 'offline',
            cnapi: apis.cnapi || 'offline',
            napi: apis.napi || 'offline'
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
