/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var fs = require('fs');
var path = require('path');
var restify = require('restify');
var mod_url = require('url');
var util = require('util');



// --- Globals


var DEFAULT_CFG = path.join(__dirname, '..', '/config.json');
var config = {};
try {
    config = JSON.parse(fs.readFileSync(DEFAULT_CFG, 'utf8'));
} catch (e) {}

var CNAPI_URL = config.cnapi.url;
var IMGAPI_URL = config.imgapi.url;
var NAPI_URL = config.napi.url;
var PAPI_URL = config.papi.url;
var VMAPI_URL = process.env.VMAPI_URL || 'http://localhost';
var VOLAPI_URL = config.volapi.url;

var VMS_LIST_ENDPOINT = '/vms';

assert.string(CNAPI_URL, 'config.cnapi.url');
assert.string(IMGAPI_URL, 'config.imgapi.url');
assert.string(NAPI_URL, 'config.napi.url');
assert.string(PAPI_URL, 'config.papi.url');
assert.string(VMAPI_URL, 'process.env.VMAPI_URL');
assert.optionalString(VOLAPI_URL, 'config.volapi.url');


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

    var papi = restify.createJsonClient({
        url: PAPI_URL,
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

    var volapi;
    if (VOLAPI_URL) {
        volapi = restify.createJsonClient({
            url: VOLAPI_URL,
            /*
             * Use a specific version and not the latest one (with "*"") to
             * avoid breakage when VOLAPI's API changes in a way that is not
             * backward compatible.
             */
            version: '^1',
            log: logger,
            agent: false
        });

        client.volapi = volapi;
    }

    var imgapi = restify.createJsonClient({
        url: IMGAPI_URL,
        version: '*',
        log: logger,
        agent: false
    });

    client.cnapi = cnapi;
    client.imgapi = imgapi;
    client.napi = napi;
    client.papi = papi;

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
function ifError(t, err, prefix) {
    t.ok(!err,
        (prefix ? prefix + ': ' : '') +
        (err ? ('error: ' + err.message) : 'no error'));
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

        // If we hit a permanent state that's incompatible with what we
        // expected, we can fail right away instead of waiting for the timeout.
        if (url.indexOf('/jobs/') === 0) {
            if (value === 'succeeded' && body[key] === 'failed') {
                callback(new Error(url +
                    ' failed when we expected "succeeded"'));
                return;
            } else if (value === 'failed' && body[key] === 'succeeded') {
                callback(new Error(url +
                    ' succeeded when we expected "failed"'));
                return;
            }
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
    assert.optionalBool(options.waitUntilNotEqual, 'options.waitUntilNotEqual');
    assert.func(callback, 'callback');

    var client = options.client;

    // Set a longish timeout value to allow for slow tests that do eventually
    // complete. For instance, concurrent test execution on older hardware.
    var timeout = 10 * 60;
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

/*
 * Wait for the vmapi workflow job to change execution state away from 'queued'
 * and 'running'.
 *
 * callback(err, executionValue, job)
 */
function waitForJob(options, callback) {
    assert.object(options, 'options');
    assert.uuid(options.job_uuid, 'options.job_uuid');
    assert.object(options.client, 'options.client');
    assert.optionalNumber(options.timeout, 'options.timeout');
    assert.func(callback, 'callback');

    var client = options.client;
    var runSeconds = 0;
    var timeout = 120;
    var url = '/jobs/' + options.job_uuid;

    if (options.timeout !== undefined) {
        timeout = options.timeout;
    }

    function waitUntilWorkflowStateChanges() {
        client.get(url, function (err, req, res, job) {
            if (err) {
                callback(err);
                return;
            }

            var execution = job && job['execution'] || '(No execution)';

            if (execution === 'queued' || execution === 'running') {
                runSeconds++;

                if (runSeconds >= timeout) {
                    callback(new Error('Timeout waiting on ' + url));
                } else {
                    setTimeout(function () {
                        waitUntilWorkflowStateChanges();
                    }, 1000);
                }
            } else {
                callback(null, execution, job);
            }
        });
    }

    waitUntilWorkflowStateChanges();
}

/*
 * Given an array of networks (most likely returned from napi GET /networks),
 * find the admin and external network and return them as an object.  This
 * function will throw if neither network is found, or multiple networks with
 * the name external or admin are found.
 */
function extractAdminAndExternalNetwork(networks) {
    assert.arrayOfObject(networks, 'networks');

    var ret = {};
    networks.forEach(function forEachNetwork(network) {
        assert.string(network.name, 'network.name');

        if (['admin', 'external'].indexOf(network.name) >= 0) {
            assert(!ret.hasOwnProperty(network.name), util.format(
                'network defined more than once: "%s"', network.name));
            ret[network.name] = network;
        }
    });
    assert.object(ret.admin, 'admin network not found');
    assert.object(ret.external, 'external network not found');

    return ret;
}

function findHeadnode(t, client, callback) {
    client.cnapi.get({
        path: '/servers',
        query: {
            headnode: true
        }
    }, function (err, req, res, servers) {
        if (err) {
            callback(err);
            return;
        }
        t.equal(res.statusCode, 200, '200 OK');
        t.ok(servers, 'servers is set');
        t.ok(Array.isArray(servers), 'servers is Array');
        for (var i = 0; i < servers.length; i++) {
            if (servers[i].status === 'running') {
                callback(null, servers[i]);
                return;
            }
        }
        callback(new Error('No running headnode server was found'));
    });
}

module.exports = {
    setUp: setUp,
    checkHeaders: checkHeaders,
    testListInvalidParams: testListInvalidParams,
    testListValidParams: testListValidParams,
    config: config,
    ifError: ifError,
    VMS_LIST_ENDPOINT: VMS_LIST_ENDPOINT,
    waitForValue: waitForValue,
    waitForJob: waitForJob,
    extractAdminAndExternalNetwork: extractAdminAndExternalNetwork,
    findHeadnode: findHeadnode
};
