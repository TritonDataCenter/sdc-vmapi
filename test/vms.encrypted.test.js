/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

// Test instance encryption.

var assert = require('assert-plus');
var uuid = require('uuid');

var common = require('./common');


// --- Globals

var client;
var pkg256;
var vmLocation;

var ADMIN_NETWORK = null;
var EXTERNAL_NETWORK = null;
var CUSTOMER = common.config.ufdsAdminUuid;
var IMAGE = 'fd2cc906-8938-11e3-beab-4359c665ac99'; // sdc-smartos
var PACKAGE_NAME_256 = 'sample-256M';
var ZPOOL_ENCRYPTION_AVAILABLE = false;

var CALLER = {
    type: 'signature',
    ip: '127.0.0.68',
    keyId: '/foo@joyent.com/keys/id_rsa'
};


// --- Helpers

function createOpts(path, params) {
    return {
        path: path,
        headers: {
            'x-request-id': uuid.v4(),
            'x-context': JSON.stringify({
                caller: CALLER,
                params: params || {}
            })
        }
    };
}


// --- Tests

exports.setUp = function (callback) {
    common.setUp(function (err, _client) {
        assert.ifError(err);
        assert.ok(_client, 'restify client');
        client = _client;
        callback();
    });
};

// Count the servers that support encryption.
exports.count_encrypted_servers = function test_count_running_servers(t) {
    client.cnapi.get({path: '/servers?setup=true&extras=sysinfo'},
            function _onGetServersCb(err, req, res, servers) {
        common.ifError(t, err, 'get cnapi setup servers');

        if (servers) {
            // Filter running servers and virtual servers.
            var availableServers = servers.filter(function _checkZpoolEnc(s) {
                return s.status === 'running' && s.sysinfo &&
                    s.sysinfo.hasOwnProperty('Zpool Encrypted') &&
                    Boolean(s.sysinfo['Zpool Encrypted']);
            });

            t.ok(true, 'number of zpool encrypted servers: ' +
                availableServers.length);

            if (availableServers.length) {
                ZPOOL_ENCRYPTION_AVAILABLE = true;
            }
        }

        t.done();
    });
};

// Other tests depend on there being both an 'admin' and 'external' network.
// This test loads these and ensures we have both.
exports.fetch_napi_networks = function (t) {
    client.napi.get('/networks', function (err, req, res, networks) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        t.ok(networks, 'networks is set');
        t.ok(Array.isArray(networks), 'networks is Array');
        t.ok(networks.length > 1, 'more than 1 network found');
        var adminExtNetworks = common.extractAdminAndExternalNetwork(networks);
        ADMIN_NETWORK = adminExtNetworks.admin;
        EXTERNAL_NETWORK = adminExtNetworks.external;
        t.ok(ADMIN_NETWORK, 'admin network is ' +
            (ADMIN_NETWORK ? ADMIN_NETWORK.uuid : ADMIN_NETWORK));
        t.ok(EXTERNAL_NETWORK, 'external network is ' +
            (EXTERNAL_NETWORK ? EXTERNAL_NETWORK.uuid : EXTERNAL_NETWORK));
        t.done();
    });
};

exports.find_256M_package = function (t) {
    client.papi.get('/packages?name=' + PACKAGE_NAME_256 + '&active=true',
            function getPackages(err, req, res, packages) {
        common.ifError(t, err, 'getting packages');
        if (err) {
            t.done();
            return;
        }

        t.ok(packages.length > 0, 'found package named: ' + PACKAGE_NAME_256);
        if (packages.length > 0) {
            pkg256 = packages[0];
        }

        t.done();
    });
};


exports.create_vm_256m = function (t) {
    if (!pkg256) {
        t.ok(false, 'Skipping - no package was found');
        t.done();
        return;
    }

    if (!ZPOOL_ENCRYPTION_AVAILABLE) {
        t.ok(true, 'Skipping - no servers support zpool encryption');
        t.done();
        return;
    }

    var vm = {
        owner_uuid: CUSTOMER,
        image_uuid: IMAGE,
        networks: [ { uuid: ADMIN_NETWORK.uuid } ],
        brand: 'joyent-minimal',
        billing_id: pkg256.uuid,
        internal_metadata: {
            encrypted: true
        },
        tags: {
            'triton.placement.exclude_virtual_servers': true
        }
    };

    var opts = createOpts('/vms', vm);

    client.post(opts, vm, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'vm ok');

        var jobLocation = '/jobs/' + body.job_uuid;
        t.ok(body.job_uuid, 'body.job_uuid jobLocation: ' + jobLocation);

        if (!body.job_uuid) {
            t.done();
            return;
        }

        common.waitForValue(jobLocation, 'execution', 'succeeded', {
            client: client
        }, function (err2) {
            common.ifError(t, err2, 'no error when creating vm');
            if (!err2) {
                vmLocation = '/vms/' + body.vm_uuid;
            }
            t.done();
        });
    });
};


exports.get_vm_ok = function (t) {
    if (!ZPOOL_ENCRYPTION_AVAILABLE) {
        t.ok(true, 'Skipping - no servers support zpool encryption');
        t.done();
        return;
    }

    if (!vmLocation) {
        t.ok(false, 'Skipping - no vm was created');
        t.done();
        return;
    }

    var path = vmLocation + '?owner_uuid=' + CUSTOMER + '&state=active';

    client.get(path, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'vm ok');
        t.ok(body.internal_metadata, 'internal metadata');
        t.ok(body.internal_metadata.encrypted, 'internal metadata encrypted');
        t.done();
    });
};

exports.destroy_vm = function (t) {
    if (!ZPOOL_ENCRYPTION_AVAILABLE) {
        t.ok(true, 'Skipping - no servers support zpool encryption');
        t.done();
        return;
    }

    if (!vmLocation) {
        t.ok(false, 'Skipping - no vm was created');
        t.done();
        return;
    }

    var opts = createOpts(vmLocation);

    client.del(opts, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body is set');

        var jobLocation = '/jobs/' + body.job_uuid;
        t.ok(body.job_uuid, 'body.job_uuid jobLocation: ' + jobLocation);

        if (!body.job_uuid) {
            t.done();
            return;
        }

        common.waitForValue(jobLocation, 'execution', 'succeeded', {
            client: client
        }, function (err2) {
            common.ifError(t, err2, 'no error when deleting instance');
            t.done();
        });
    });
};
