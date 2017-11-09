/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var crypto = require('crypto');
var fs = require('fs');
var jsprim = require('jsprim');
var moray = require('moray');
var path = require('path');
var restify = require('restify');
var mod_url = require('url');
var util = require('util');
var vasync = require('vasync');

var morayBucketsConfig = require('../lib/moray/moray-buckets-config');
var Moray = require('../lib/apis/moray');


// --- Globals

var USER = 'admin';
var PASSWD = 'z3cr3t';

var DEFAULT_CFG = path.join(__dirname, '..', '/config.json');
var config = {};
try {
    config = JSON.parse(fs.readFileSync(DEFAULT_CFG, 'utf8'));
} catch (e) {}

var CNAPI_URL = config.cnapi.url || 'http://10.99.99.22';
var IMGAPI_URL = config.imgapi.url || 'http://10.99.99.21';
var NAPI_URL = config.napi.url || 'http://10.99.99.10';
var VMAPI_URL = process.env.VMAPI_URL || 'http://localhost';
var VOLAPI_URL = config.volapi.url || 'http://10.99.99.42';

var VMS_LIST_ENDPOINT = '/vms';

// --- Library

function setUp(callback) {
    assert.ok(callback);

    var logger = new bunyan.createLogger({
        level: process.env.LOG_LEVEL || 'info',
        name: 'vmapi_unit_test',
        stream: process.stderr,
        serializers: {
            err: bunyan.stdSerializers.err,
            req: bunyan.stdSerializers.req,
            res: restify.bunyan.serializers.res
        }
    });

    var client = restify.createJsonClient({
        url: VMAPI_URL,
        version: '*',
        log: logger,
        agent: false
    });

    var napi = restify.createJsonClient({
        url: NAPI_URL,
        version: '*',
        log: logger,
        agent: false
    });

    var cnapi = restify.createJsonClient({
        url: CNAPI_URL,
        version: '*',
        log: logger,
        agent: false
    });

    var volapi = restify.createJsonClient({
        url: VOLAPI_URL,
        /*
         * Use a specific version and not the latest one (with "*"") to avoid
         * breakage when VOLAPI's API changes in a way that is not backward
         * compatible.
         */
        version: '^1',
        log: logger,
        agent: false
    });

    var imgapi = restify.createJsonClient({
        url: IMGAPI_URL,
        version: '*',
        log: logger,
        agent: false
    });

    client.cnapi = cnapi;
    client.imgapi = imgapi;
    client.napi = napi;
    client.volapi = volapi;

    return callback(null, client);
}

/*
 * Makes sure that sending the params "params" as parameters to
 * the vms listing endpoint results in a request error.
 */
function testListInvalidParams(client, params, expectedError, t, callback) {
    var query = mod_url.format({pathname: VMS_LIST_ENDPOINT, query: params});

    return client.get(query, function (err, req, res, body) {
        t.equal(res.statusCode, 409,
        'sending ' + util.inspect(params) +
        ' parameters should result in an error status code');
        t.deepEqual(body, expectedError,
        'sending ' + util.inspect(params) + ' for parameters '
        + ' should result in the proper error message being sent');
        return callback();
    });
}

/*
 * Makes sure that sending the parameters "params" to
 * the vms listing endpoint does not result in a request error.
 */
function testListValidParams(client, params, t, callback) {
    var query = mod_url.format({pathname: VMS_LIST_ENDPOINT, query: params});

    return client.get(query, function (err, req, res, body) {
        t.equal(res.statusCode, 200,
        'sending params ' + util.inspect(params) +
        ' should not result in an error status code');
        return callback(err, body);
    });
}

function checkHeaders(t, headers) {
    assert.ok(t);
    // t.ok(headers, 'good headers');
    // t.ok(headers['access-control-allow-origin'], 'allow origin header');
    // t.ok(headers['access-control-allow-methods'],
    //          'allow methods header');
    // t.ok(headers.date, 'date header');
    // t.ok(headers['x-request-id'], 'request id header');
    // t.ok(headers['x-response-time'] >= 0, 'response time header');
    // t.equal(headers.server, 'VMs API', 'server header');
    // t.equal(headers.connection, 'Keep-Alive', 'connection header');
    // t.equal(headers['x-api-version'], '7.0.0');
}

/*
 * like t.ifError with a printed message
 */
function ifError(t, err) {
    t.ok(!err, err ? ('error: ' + err.message) : 'no error');
}


function checkEqual(value, expected) {
    if ((typeof (value) === 'object') && (typeof (expected) === 'object')) {
        var exkeys = Object.keys(expected);
        for (var i = 0; i < exkeys.length; i++) {
            var key = exkeys[i];
            if (value[key] !== expected[key])
                return false;
        }

        return true;
    } else {
        return (value === expected);
    }
}

function checkValue(client, url, key, value, callback) {
    client.get(url, function (err, req, res, body) {
        if (err) {
            callback(err);
            return;
        }

        callback(null, checkEqual(body[key], value));
    });
}

function waitForValue(url, key, value, options, callback) {
    assert.string(url, 'url');
    assert.string(key, 'key');
    assert.object(options, 'options');
    assert.object(options.client, 'options.client');
    assert.optionalNumber(options.timeout, 'options.timeout');
    assert.func(callback, 'callback');

    var client = options.client;
    var timeout = 120;
    var times = 0;

    if (options.timeout !== undefined) {
        timeout = options.timeout;
    }

    function performCheck() {
        checkValue(client, url, key, value, function onChecked(err, ready) {
            if (err) {
                callback(err);
                return;
            }

            if (!ready) {
                times++;

                if (times === timeout) {
                    callback(new Error('Timeout waiting on ' + url));
                } else {
                    setTimeout(function () {
                        performCheck();
                    }, 1000);
                }
            } else {
                callback(null);
            }
        });
    }

    performCheck();
}

module.exports = {
    setUp: setUp,
    checkHeaders: checkHeaders,
    testListInvalidParams: testListInvalidParams,
    testListValidParams: testListValidParams,
    config: config,
    ifError: ifError,
    VMS_LIST_ENDPOINT: VMS_LIST_ENDPOINT,
    waitForValue: waitForValue
};
