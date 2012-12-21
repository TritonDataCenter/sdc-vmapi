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
        moray: pingMoray,
        wfapi: pingWfapi
    }, afterParallel);

    function pingCnapi(cb) {
        req.cnapi.ping(function (err) {
            var status = (err === undefined || err === null) ? 'online'
                                                             : 'offline';
            return cb(null, { status: status, error: err });
        });
    }

    function pingNapi(cb) {
        req.napi.ping(function (err) {
            var status = (err === undefined || err === null) ? 'online'
                                                             : 'offline';
            return cb(null, { status: status, error: err });
        });
    }

    function pingMoray(cb) {
        req.moray.ping(function (err) {
            var status = (err === undefined || err === null) ? 'online'
                                                             : 'offline';
            return cb(null, { status: status, error: err });
        });
    }

    function pingWfapi(cb) {
        req.wfapi.ping(function (err) {
            var status = (err === undefined || err === null) ? 'online'
                                                             : 'offline';
            return cb(null, { status: status, error: err });
        });
    }

    function afterParallel(err, results) {
        var errors = {};
        // Cycle through it so we can log ping errors
        for (var api in results) {
            if (results[api].error) {
                req.log.error(results[api].error, 'Error while pinging ' + api);
                errors[api] = results[api].error;
            }
        }

        return callback(results, errors);
    }
}



/*
 * GET /ping
 */
function ping(req, res, next) {
    req.log.trace('Ping start');

    pingApis(req, function (results, errors) {
        var services = {
            redis: req.cache.connected() === true ? 'online' : 'offline',
            wfapi: results.wfapi.status,
            moray: results.moray.status,
            cnapi: results.cnapi.status,
            napi: results.napi.status
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

        var response = {
            healthy: healthy,
            services: services,
            pingErrors: errors,
            lastHeartbeatReceived: req.heartbeater.lastReceived,
            lastHeartbeatProcessed: req.heartbeater.lastProcessed
        };

        res.send(status, response);
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
