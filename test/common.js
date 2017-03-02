/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

var assert = require('assert-plus');
var crypto = require('crypto');
var path = require('path');
var fs = require('fs');
var url = require('url');
var util = require('util');

var Logger = require('bunyan');
var restify = require('restify');


// --- Globals

var USER = 'admin';
var PASSWD = 'z3cr3t';

var DEFAULT_CFG = path.join(__dirname, '..', '/config.json');
var config = {};
try {
    config = JSON.parse(fs.readFileSync(DEFAULT_CFG, 'utf8'));
} catch (e) {}

var VMAPI_URL = process.env.VMAPI_URL || 'http://localhost';
var NAPI_URL = config.napi.url || 'http://10.99.99.10';
var CNAPI_URL = config.cnapi.url || 'http://10.99.99.22';

var VMS_LIST_ENDPOINT = '/vms';

// --- Library

function setUp(callback) {
    assert.ok(callback);

    var logger = new Logger({
        level: process.env.LOG_LEVEL || 'info',
        name: 'vmapi_unit_test',
        stream: process.stderr,
        serializers: {
            err: Logger.stdSerializers.err,
            req: Logger.stdSerializers.req,
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

    client.napi = napi;
    client.cnapi = cnapi;

    return callback(null, client);
}

/*
 * Makes sure that sending the params "params" as parameters to
 * the vms listing endpoint results in a request error.
 */
function testListInvalidParams(client, params, expectedError, t, callback) {
    var query = url.format({pathname: VMS_LIST_ENDPOINT, query: params});

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
    var query = url.format({pathname: VMS_LIST_ENDPOINT, query: params});

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

module.exports = {
    setUp: setUp,
    checkHeaders: checkHeaders,
    testListInvalidParams: testListInvalidParams,
    testListValidParams: testListValidParams,
    config: config,
    ifError: ifError,
    VMS_LIST_ENDPOINT: VMS_LIST_ENDPOINT
};
