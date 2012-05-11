// Copyright 2011 Joyent, Inc.  All rights reserved.
var assert = require('assert');
var crypto = require('crypto');

var Logger = require('bunyan');
var restify = require('restify');
var uuid = require('node-uuid');

var UFDS = require('sdc-clients').UFDS;



// --- Globals

var USER = 'admin';
var PASSWD = 'z3cr3t';



// --- Library

module.exports = {

    setup: function (callback) {
        assert.ok(callback);

        var user = 'a' + uuid().substr(0, 7) + '@joyent.com';

        var logger = new Logger({
            level: process.env.LOG_LEVEL || 'info',
            name: 'zapi_unit_test',
            stream: process.stderr,
            serializers: {
                err: Logger.stdSerializers.err,
                req: Logger.stdSerializers.req,
                res: restify.bunyan.serializers.response
            }
        });

        var client = restify.createStringClient({
            url: 'http://localhost:8080',
            version: '*',
            retryOptions: {
                retry: 0
            },
            log: logger
        });

        client.basicAuth(USER, PASSWD);
        client.testUser = user;

        var ufds = new UFDS({
            url: 'ldaps://10.99.99.15',
            bindDN: 'cn=root',
            bindPassword: 'secret'
        });
        ufds.on('error', function (err) {
            return callback(err);
        });
        ufds.on('ready', function () {
            var entry = {
                login: client.testUser,
                email: client.testUser,
                userpassword: PASSWD
            };
            return ufds.addUser(entry, function (err, newUser) {
                if (err)
                    return callback(err);

                client.testUser = newUser;
                client.ufds = ufds;
                client.teardown = function teardown(cb) {
                    client.ufds.deleteUser(client.testUser, function (anErr) {
                        if (err) // blindly ignore
                            return cb(anErr);

                        ufds.close(function () {});
                        return cb(null);
                    });
                };

                return callback(null, client);
            });
        });
    },

    checkHeaders: function (t, headers) {
        assert.ok(t);

        t.ok(headers, 'good headers');
        t.ok(headers['access-control-allow-origin'], 'allow origin header');
        t.ok(headers['access-control-allow-methods'], 'allow methods header');
        t.ok(headers.date, 'date header');
        t.ok(headers['x-request-id'], 'request id header');
        t.ok(headers['x-response-time'] >= 0, 'response time header');
        t.equal(headers.server, 'Zones API', 'server header');
        t.equal(headers.connection, 'Keep-Alive', 'connection header');
        // t.equal(headers['x-api-version'], '7.0.0');
    }

};
