/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Handler for the /ping endpoint including data about connected backing
 * services.
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
        var wfapi = (req.app.wfapi.connected === true) ? 'online' : 'offline';

        var services = {
            moray: results.status,
            wfapi: wfapi
        };

        var healthy = true;
        var response = {};
        var status = 'OK';

        for (var name in services) {
            if (services[name] === 'offline') {
                healthy = false;
                status = 'some services are not connected';
                break;
            }
        }

        if (services.moray === 'offline') {
            response.pingErrors = { moray: results.error };
        } else {
            response.pingErrors = {};
        }

        response.pid = process.pid;
        response.status = status;
        response.healthy = healthy;
        response.services = services;

        res.send(200, response);
        return next();
    });
}



/*
 * Mounts job actions as server routes
 */
function mount(server) {
    server.get({ path: '/ping', name: 'Ping' }, ping);
}


// --- Exports

module.exports = {
    mount: mount
};
