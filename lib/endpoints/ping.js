/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * Handler for the /ping endpoint including data about connected backing
 * services.
 */

var assert = require('assert-plus');
var restify = require('restify');
var vasync = require('vasync');

var common = require('../common');

var ONLINE_STATUS = 'online';
var OFFLINE_STATUS = 'offline';

var OK_OVERALL_STATUS = 'OK';
var NOT_OK_OVERALL_STATUS = 'some services are not ready';

/*
 * GET /ping
 */
function ping(req, res, next) {
    var morayInitialization;
    var morayStatus = OFFLINE_STATUS;
    var wfapiServiceStatus = OFFLINE_STATUS;
    var overallHealthy = true;
    var overallStatus = OK_OVERALL_STATUS;
    var pingErrors = {};
    var response = {};
    var responseCode = 200;

    vasync.parallel({funcs: [
        function getMorayConnectivity(done) {
            req.log.debug('pinging moray...');

            req.app.moray.ping(function onMorayPinged(pingErr) {
                if (pingErr) {
                    req.log.debug({
                        err: pingErr
                    }, 'moray ping error');
                } else {
                    req.log.debug('successfully pinged moray');
                }

                if (!pingErr) {
                    morayStatus = ONLINE_STATUS;
                } else {
                    overallHealthy = false;
                    overallStatus = NOT_OK_OVERALL_STATUS;
                    pingErrors.moray = pingErr;
                }

                done();
            });
        },
        function getMorayInitialization(done) {
            var dataMigrationError;
            var modelName;

            assert.object(req.app.morayBucketsInitializer,
                'req.app.morayBucketsInitializer');

            req.log.debug('checking moray initialization status...');

            var morayBucketsInitStatus =
                req.app.morayBucketsInitializer.status();
            var morayBucketsReindexStatus;
            var morayBucketsSetupStatus;

            assert.object(morayBucketsInitStatus, 'morayBucketsInitStatus');
            morayBucketsReindexStatus = morayBucketsInitStatus.bucketsReindex;
            morayBucketsSetupStatus = morayBucketsInitStatus.bucketsSetup;

            assert.object(morayBucketsReindexStatus,
                'morayBucketsReindexStatus');
            assert.object(morayBucketsSetupStatus,
                'morayBucketsSetupStatus');

            if (morayBucketsSetupStatus.state !== 'DONE' ||
                morayBucketsReindexStatus.state !== 'DONE') {
                overallHealthy = false;
            }

            if (morayBucketsSetupStatus.state !== 'DONE') {
                overallStatus = NOT_OK_OVERALL_STATUS;
            }

            morayInitialization = morayBucketsInitStatus;

            /*
             * Render all error objects so that they are human readable when
             * sent as part of the JSON output of the endpoint.
             */
            if (morayBucketsSetupStatus.latestError) {
                morayInitialization.bucketsSetup.latestError =
                    morayInitialization.bucketsSetup.latestError.toString();
            }

            if (morayInitialization.bucketsReindex.latestError) {
                morayInitialization.bucketsReindex.latestError =
                    morayInitialization.bucketsReindex.latestError.toString();
            }

            for (modelName in
                morayInitialization.dataMigrations.latestErrors) {
                dataMigrationError =
                    morayInitialization.dataMigrations.latestErrors[modelName];
                morayInitialization.dataMigrations.latestErrors[modelName] =
                    dataMigrationError.toString();
            }

            req.log.debug(morayInitialization,
                'moray buckets initialization status');

            done();
        },
        function getWfApiConnectivity(done) {
            req.log.debug({wfapiUrl: req.app.wfapi.url},
                'checking wfapi connectivity...');

            if (req.app.wfapi && req.app.wfapi.connected === true) {
                wfapiServiceStatus = ONLINE_STATUS;
            } else {
                overallHealthy = false;
                overallStatus = NOT_OK_OVERALL_STATUS;
            }

            req.log.debug({
                status: wfapiServiceStatus
            }, 'wfapi connectivity check results');

            done();
        }
    ]}, function allStatusInfoRetrieved(err) {
        req.log.debug('all status info retrieved');

        var services = {
            moray: morayStatus,
            wfapi: wfapiServiceStatus
        };

        if (overallStatus === NOT_OK_OVERALL_STATUS) {
            responseCode = 503;
        }

        response.healthy = overallHealthy;
        response.initialization = {
            moray: morayInitialization
        };
        response.pid = process.pid;
        response.pingErrors = pingErrors;
        response.status = overallStatus;
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
