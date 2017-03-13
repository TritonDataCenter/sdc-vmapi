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

var changefeedTest = require('../lib/changefeed');
var configLoader = require('../../lib/config-loader');
var MORAY = require('../../lib/apis/moray');
var morayTest = require('../lib/moray');
var vmapi = require('../../lib/vmapi');

var UNIQUE_ENDPOINT_PATH = '/' + libuuid.create();

var CONFIG_FILE_PATH = path.join(__dirname, '../..', 'config.json');
var CONFIG = configLoader.loadConfig(CONFIG_FILE_PATH);

function throwingRestifyHandler(req, res, next) {
    throw new Error('boom');
}

var morayApi;
var vmapiService;

var mockedWfapiClient = {
    connected: true,
    connect: function mockedWfapiConnect(callback) {
        callback();
    }
};

var vmapiClient;

vasync.pipeline({funcs: [
    function initMoray(arg, next) {
        console.log('initializing moray...');

        morayApi = morayTest.createMorayClient();
        morayApi.connect();

        morayApi.on('moray-ready', function onMorayReady() {
            console.log('moray initialized!');
            next();
        });
    },
    function initVmapi(arg, next) {
        console.log('initializing vmapi...');

        vmapiService = new vmapi({
            apiClients: {
                wfapi: mockedWfapiClient
            },
            moray: morayApi,
            changefeedPublisher: changefeedTest.createNoopCfPublisher()
        });

        next();
    },
    function addThrowingHandler(arg, next) {
        console.log('adding throwing restify handler...');

        vmapiService.server.get({
            path: UNIQUE_ENDPOINT_PATH
        }, throwingRestifyHandler);

        next();
    },
    function listenOnVmapiServer(arg, next) {
        console.log('listening on vmapi server\'s socket...');

        vmapiService.listen({
            port: 0
        }, next);
    }
]}, function onVmapiServiceReady(initErr) {
    var vmapiServerAddress = vmapiService.server.address();
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
        vmapiService.close();
        morayApi.close();
    });
});