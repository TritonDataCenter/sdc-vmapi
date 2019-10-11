/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

// Test instance resizing.

var assert = require('assert-plus');
var uuid = require('uuid');
var vasync = require('vasync');

var common = require('./common');


// --- Globals

var client;
var pkg256;
var pkg512;
var pkgGinormous;
var vmLocation;

var ADMIN_NETWORK = null;
var EXTERNAL_NETWORK = null;
var CUSTOMER = common.config.ufdsAdminUuid;
var IMAGE = 'fd2cc906-8938-11e3-beab-4359c665ac99'; // sdc-smartos
var PACKAGE_NAME_128 = 'sample-128M';
var PACKAGE_NAME_256 = 'sample-256M';
var PACKAGE_NAME_512 = 'sample-512M';

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

exports.find_512M_package = function (t) {
    client.papi.get('/packages?name=' + PACKAGE_NAME_512 + '&active=true',
            function getPackages(err, req, res, packages) {
        common.ifError(t, err, 'getting packages');
        if (err) {
            t.done();
            return;
        }

        t.ok(packages.length > 0, 'found package named: ' + PACKAGE_NAME_512);
        if (packages.length > 0) {
            pkg512 = packages[0];
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

    var vm = {
        owner_uuid: CUSTOMER,
        image_uuid: IMAGE,
        networks: [ { uuid: ADMIN_NETWORK.uuid } ],
        brand: 'joyent-minimal',
        billing_id: pkg256.uuid
    };

    var opts = createOpts('/vms', vm);

    client.post(opts, vm, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'vm ok');

        var jobLocation = '/jobs/' + body.job_uuid;
        t.ok(body.job_uuid, 'body.job_uuid', 'jobLocation: ' + jobLocation);

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


exports.create_ginormous_package = function (t) {
    if (!vmLocation) {
        t.ok(false, 'Skipping - no vm was created');
        t.done();
        return;
    }

    var largeRamValue = // value is in MiB, so:
            10 * 1024 * // 10 EiB should be enough for anyone
            1024 *      // PiB
            1024 *      // TiB
            1024;       // GiB
    var largeQuotaValue = largeRamValue * 1024; // EiB->ZiB
    var pkgName = 'ginormous-vmapi-test-10EiB';

    client.papi.post('/packages', {
        active: true,
        cpu_cap: 10000,
        description:
            'Very large test package for VMAPI\'s vms.full.test.js',
        max_lwps: 30000,
        max_physical_memory: largeRamValue,
        max_swap: largeRamValue,
        name: pkgName,
        quota: largeQuotaValue,
        version: '1.0.0',
        vcpus: 32, // the largest papi currently allows LOL
        zfs_io_priority: 16383 // also largest papi currently allows
    }, function _onPost(err, req, res, body) {
        common.ifError(t, err, 'POST ginormous package to PAPI');

        if (!err) {
            t.ok(body.uuid, 'created package uuid: ' + body.uuid);
            t.equal(pkgName, body.name,
                'response should be our fresh package');
            pkgGinormous = body;
        }

        t.done();
    });
};

// If there's not enough spare RAM on a server, and we're resizing upwards, we
// want the provision to fail. Failure should be the normal case for this
// feature, since ideally it will never work if we've done a good job of packing
// VMs.
exports.resize_vm_to_ginormous_package = function (t) {
    if (!pkgGinormous) {
        t.ok(false, 'Skipping - no ginormous package created');
        t.done();
        return;
    }

    var params = {
        action: 'update',
        billing_id: pkgGinormous.uuid
    };
    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function _onPost(err, req, res, body) {

        var error;

        t.ok(err, 'expected error POSTing resize');
        t.equal(res.statusCode, 409, 'expected HTTP code 409');
        t.equal(body.code, 'ValidationFailed',
            'expected ValidationFailed error');
        t.equal(body.message, 'Invalid VM update parameters',
            'expected invalid update message');

        error = body.errors[0];
        t.equal(error.field, 'ram', 'error should be due to ram');
        t.equal(error.code, 'InsufficientCapacity',
            'error code should be InsufficientCapacity');
        t.ok(error.message.match(
            'Required additional RAM \\(\\d+\\) ' +
            'exceeds the server\'s available RAM \\(-?\\d+\\)'),
            'error message should explain additional RAM required');

        t.done();
    });
};

exports.delete_ginormous_package = function (t) {
    if (!pkgGinormous) {
        t.ok(false, 'Skipping - no ginormous package created');
        t.done();
        return;
    }

    client.papi.del({
        path: '/packages/' + pkgGinormous.uuid + '?force=true'
    }, function _onDel(err, req, res, body) {
        common.ifError(t, err, 'DELETE created package');

        t.equal(204, res.statusCode, 'expected 204 from DELETE');
        t.ok(!err, 'expected no restCode' + (err ? 'got ' + err.restCode : ''));

        t.done();
    });
};

exports.resize_vm_up_512m = function (t) {
    if (!vmLocation) {
        t.ok(false, 'Skipping - no vm was created');
        t.done();
        return;
    }
    if (!pkg512) {
        t.ok(false, 'Skipping - no 256M package was found');
        t.done();
        return;
    }

    var params = { action: 'update', billing_id: pkg512.uuid };

    var opts = createOpts(vmLocation + '?force=true', params);

    client.post(opts, params, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');

        var jobLocation = '/jobs/' + body.job_uuid;
        t.ok(body.job_uuid, 'body.job_uuid', 'jobLocation: ' + jobLocation);

        if (!body.job_uuid) {
            t.done();
            return;
        }

        common.waitForValue(jobLocation, 'execution', 'succeeded', {
            client: client
        }, function (err2) {
            common.ifError(t, err2);
            t.done();
        });
    });
};

// Regardless of spare RAM on server, we always want resizing down to succeed.
exports.resize_vm_down_256m = function (t) {
    if (!vmLocation) {
        t.ok(false, 'Skipping - no vm was created');
        t.done();
        return;
    }
    if (!pkg256) {
        t.ok(false, 'Skipping - no 128M package was found');
        t.done();
        return;
    }

    var params = { action: 'update', billing_id: pkg256.uuid };
    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 202, '202 Accepted');

        var jobLocation = '/jobs/' + body.job_uuid;
        t.ok(body.job_uuid, 'body.job_uuid', 'jobLocation: ' + jobLocation);

        if (!body.job_uuid) {
            t.done();
            return;
        }

        common.waitForValue(jobLocation, 'execution', 'succeeded', {
            client: client
        }, function (err2) {
            common.ifError(t, err2);
            t.done();
        });
    });
};


exports.destroy_vm = function (t) {
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
        t.ok(body.job_uuid, 'body.job_uuid', 'jobLocation: ' + jobLocation);

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
