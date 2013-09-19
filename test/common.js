// Copyright 2013 Joyent, Inc.  All rights reserved.
var assert = require('assert');
var crypto = require('crypto');
var path = require('path');
var fs = require('fs');

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

var VMAPI_URL = 'http://' + (process.env.VMAPI_IP || 'localhost:8080');
var NAPI_URL = config.napi.url || 'http://10.99.99.10';
var CNAPI_URL = config.cnapi.url || 'http://10.99.99.22';



// --- Library

module.exports = {

    setUp: function (callback) {
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
    },

    checkHeaders: function (t, headers) {
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
    },

    config: config

};
