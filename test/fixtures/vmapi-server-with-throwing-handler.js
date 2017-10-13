/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var libuuid = require('libuuid');
var mod_vmapiClient = require('sdc-clients').VMAPI;
var path = require('path');
var vasync = require('vasync');

var changefeedUtils = require('../../lib/changefeed');
var NoopDataMigrationsController =
    require('../../lib/data-migrations/noop-controller');
var VmapiApp = require('../../lib/vmapi');

var UNIQUE_ENDPOINT_PATH = '/' + libuuid.create();

function throwingRestifyHandler(req, res, next) {
    throw new Error('boom');
}

var mockedWfapiClient = {
    connected: true,
    connect: function mockedWfapiConnect(callback) {
        callback();
    }
};
var vmapiClient;
var vmapiApp;

vasync.pipeline({funcs: [
    function initVmapi(arg, next) {
        console.log('initializing vmapi...');

        vmapiApp = new VmapiApp({
            apiClients: {
                wfapi: mockedWfapiClient
            },
            moray: {
                bucketsSetup: function bucketsSetup() { return true; }
            },
            changefeedPublisher: changefeedUtils.createNoopCfPublisher(),
            dataMigrationsCtrl: new NoopDataMigrationsController(),
            morayBucketsInitializer: {
                status: function status() { return 'BUCKETS_REINDEX_DONE'; },
                lastInitError: function lastInitError() { return null; }
            }
        });

        next();
    },
    function addThrowingHandler(arg, next) {
        console.log('adding throwing restify handler...');

        vmapiApp.server.get({
            path: UNIQUE_ENDPOINT_PATH
        }, throwingRestifyHandler);

        next();
    },
    function listenOnVmapiServer(arg, next) {
        console.log('listening on vmapi server\'s socket...');

        vmapiApp.listen({
            port: 0
        }, next);
    }
]}, function onVmapiServiceReady(initErr) {
    var vmapiServerAddress = vmapiApp.server.address();
    var vmapiServerUrl = 'http://' + vmapiServerAddress.address +
        ':' + vmapiServerAddress.port;

    console.log('vmapi service ready!');

    vmapiClient = new mod_vmapiClient({
        url: vmapiServerUrl
    });

    console.log('sending GET request to throwing endpoint...');

    vmapiClient.get(UNIQUE_ENDPOINT_PATH, function onGet() {
        console.log('got response from get request!');

        vmapiClient.close();
        vmapiApp.close();
    });
});