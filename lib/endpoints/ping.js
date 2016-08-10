/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * Handler for the /ping endpoint including data about connected backing
 * services.
 */

var restify = require('restify');
var assert = require('assert-plus');
var vasync = require('vasync');

var common = require('../common');

var ONLINE_STATUS = 'online';
var OFFLINE_STATUS = 'offline';

var UNITIALIZED_STATUS = 'uninitialized';
var INITIALIZED_STATUS = 'initialized';

/*
 * For now just ping moray
 */
function pingMoray(req, callback) {
    req.app.moray.ping(function (err) {
        var status;

        if (err) {
            req.log.error(err, 'Error while pinging moray');
            status = OFFLINE_STATUS;
        } else {
            status = ONLINE_STATUS;
        }

        return callback(err, status);
    });
}

/*
 * GET /ping
 */
function ping(req, res, next) {
    var morayClientConnectivity;
    var morayInitialization;
    var wfapiServiceStatus = OFFLINE_STATUS;
    var overallHealthy = true;
    var overallStatus = 'OK';
    var response = {};
    var responseCode = 200;

    vasync.parallel({funcs: [
        function getMorayConnectivity(done) {
            req.log.debug('pinging moray...');

            var morayServiceStatus = OFFLINE_STATUS;
            var morayServiceError;

            pingMoray(req, function onMorayPinged(err, status) {
                req.log.debug({
                    error: err,
                    status: status
                }, 'moray ping results');

                if (!err) {
                    morayServiceStatus = ONLINE_STATUS;
                } else {
                    overallHealthy = false;
                    morayServiceError = err;
                }

                morayClientConnectivity = {
                    status: morayServiceStatus,
                    error: morayServiceError
                };

                done();
            });
        },
        function getMorayInitialization(done) {
            req.log.debug('checking moray initialization status...');

            var morayInitStatus = UNITIALIZED_STATUS;
            var morayInitError;

            if (req.app.moray.initialized() === true) {
                morayInitStatus = INITIALIZED_STATUS;
            }

            morayInitError = req.app.moray.lastInitError();
            assert.optionalObject(morayInitError, 'morayInitError');
            if (morayInitError) {
                morayInitError = morayInitError.toString();
            }

            if (morayInitError || morayInitStatus === UNITIALIZED_STATUS) {
                overallHealthy = false;
            }

            req.log.debug({
                error: morayInitError,
                status: morayInitStatus
            }, 'moray initialization check results');

            morayInitialization = {
                status: morayInitStatus
            };

            if (morayInitError) {
                morayInitialization.error = morayInitError;
            }

            done();
        },
        function getWfApiConnectivity(done) {
            req.log.debug({wfapi: req.app.wfapi},
                'checking wfapi connectivity...');

            if (req.app.wfapi && req.app.wfapi.connected === true) {
                wfapiServiceStatus = ONLINE_STATUS;
            } else {
                overallHealthy = false;
            }

            req.log.debug({
                status: wfapiServiceStatus
            }, 'wfapi connectivity check results');

            done();
        }
    ]}, function allStatusInfoRetrieved(err) {
        req.log.debug('all status info retrieved');

        var services = {
            moray: {
                connectivity: morayClientConnectivity,
                initialization: morayInitialization
            },
            wfapi: {
                status: wfapiServiceStatus
            }
        };

        if (overallHealthy === false) {
            responseCode = 503;
            overallStatus = 'some services are not ready';
        }

        response.pid = process.pid;
        response.status = overallStatus;
        response.healthy = overallHealthy;
        response.services = services;

        res.send(responseCode, response);
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
