/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

// Test bhyve (regular and flexible disk) instance resizing.

var assert = require('assert-plus');
var jsprim = require('jsprim');
var uuid = require('uuid');

var common = require('./common');


// --- Globals

var client;
var pkgGinormous;
var pkgSample1G;
var pkgSampleSmallBhyveFlex;
var pkgSampleBhyveFlex;
var vmLocation;

var ADMIN_NETWORK = null;
var EXTERNAL_NETWORK = null;
var CUSTOMER = common.config.ufdsAdminUuid;
var IMAGE;
var IMAGE_PREFIX = 'ubuntu-certified';
var PACKAGE_NAME_SAMPLE_1G = 'sample-1G';
var PACKAGE_NAME_SAMPLE_BHYVE_FLEX_1G_SMALL = 'sample-bhyve-flexible-1G';
var PACKAGE_NAME_SAMPLE_BHYVE_FLEX_1G = 'sample-bhyve-reserved-snapshots-space';

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

exports.find_sample_1g_package = function (t) {
    client.papi.get('/packages?name=' + PACKAGE_NAME_SAMPLE_1G + '&active=true',
            function getPackages(err, req, res, packages) {
        common.ifError(t, err, 'getting packages');
        if (err) {
            t.done();
            return;
        }

        t.ok(packages.length > 0, 'found package named: ' +
            PACKAGE_NAME_SAMPLE_1G);
        if (packages.length > 0) {
            pkgSample1G = packages[0];
        }

        t.done();
    });
};

exports.find_small_flexible_disk_package = function (t) {
    client.papi.get('/packages?name=' +
            PACKAGE_NAME_SAMPLE_BHYVE_FLEX_1G_SMALL + '&active=true',
            function getPackages(err, req, res, packages) {
        common.ifError(t, err, 'getting packages');
        if (err) {
            t.done();
            return;
        }

        t.ok(packages.length > 0, 'found package named: ' +
            PACKAGE_NAME_SAMPLE_BHYVE_FLEX_1G_SMALL);
        if (packages.length > 0) {
            pkgSampleSmallBhyveFlex = packages[0];
        }

        t.done();
    });
};

exports.find_flexible_disk_package = function (t) {
    client.papi.get('/packages?name=' + PACKAGE_NAME_SAMPLE_BHYVE_FLEX_1G +
            '&active=true',
            function getPackages(err, req, res, packages) {
        common.ifError(t, err, 'getting packages');
        if (err) {
            t.done();
            return;
        }

        t.ok(packages.length > 0, 'found package named: ' +
            PACKAGE_NAME_SAMPLE_BHYVE_FLEX_1G);
        if (packages.length > 0) {
            pkgSampleBhyveFlex = packages[0];
        }

        t.done();
    });
};

exports.find_image_by_name = function (t) {
    client.imgapi.get('/images?name=~' + IMAGE_PREFIX +
            '&state=active&type=zvol',
            function getImages(err, req, res, images) {
        common.ifError(t, err, 'getting images');
        if (err) {
            t.done();
            return;
        }

        t.ok(images.length > 0, 'found active zvol image with name prefix: ' +
            IMAGE_PREFIX);
        if (images.length > 0) {
            // Use the last (the latest) image.
            IMAGE = images.slice(-1)[0];

            // The bhyve tests expect the image disk size to be 10 GiB.
            t.equal(IMAGE.image_size, 10240, 'Image size should be 10240');
        }

        t.done();
    });
};

exports.create_bhyve_vm = function (t) {
    if (!pkgSample1G) {
        t.ok(false, 'Skipping - no sample 1G package was found');
        t.done();
        return;
    }

    if (!IMAGE) {
        t.ok(false, 'Skipping - no image was found');
        t.done();
        return;
    }

    var vm = {
        billing_id: pkgSample1G.uuid,
        brand: 'bhyve',
        cpu_cap: 100,
        owner_uuid: CUSTOMER,
        vcpus: 1,
        networks: [ { uuid: EXTERNAL_NETWORK.uuid } ],
        disks: [
            { image_uuid: IMAGE.uuid }, // 10 GiB image
            { size: 20 * 1024 } // 20 GiB disk
        ]
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
                t.ok(body.vm_uuid, 'body.vm_uuid', 'vm_uuid: ' + body.vm_uuid);
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
    if (!pkgSampleBhyveFlex) {
        t.ok(false, 'Skipping - no flexible disk package was found');
        t.done();
        return;
    }

    var largeQuotaValue = // value is in MiB, so:
            10 * 1024 * // 10 ZiB should be enough for anyone
            1024 *      // EiB
            1024 *      // PiB
            1024 *      // TiB
            1024;       // GiB
    var pkgName = 'ginormous-vmapi-test-flex-disk-10ZiB';

    var params = jsprim.mergeObjects(pkgSampleBhyveFlex, {
        name: pkgName,
        description: 'Test package for VMAPI vms.resize.bhyve.test.js',
        quota: largeQuotaValue
    });
    delete params.uuid;

    client.papi.post('/packages', params,
            function _onPost(err, req, res, body) {

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

// When there's not enough spare RAM on a server, and we're resizing upwards, we
// want the provision to fail. Failure should be the normal case for this
// feature, since ideally it will never work if we've done a good job of packing
// VMs.
exports.resize_vm_to_ginormous_package_gets_error = function (t) {
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
        t.ok(err, 'expected error POSTing resize');
        t.ok(res, 'expect a restify response object');
        t.ok(body, 'expect a restify response body object');

        if (res && body) {
            t.equal(res.statusCode, 409, 'expected HTTP code 409');
            t.equal(body.code, 'ValidationFailed',
                'expected ValidationFailed error');
            t.equal(body.message, 'Invalid VM update parameters',
                'expected invalid update message');

            if (Array.isArray(body.errors) && body.errors.length > 0) {
                t.equal(body.errors[0].field, 'quota',
                    'error should be due to quota');
                t.equal(body.errors[0].code, 'InsufficientCapacity',
                    'error code should be InsufficientCapacity');
                t.ok(body.errors[0].message.match(
                    'Required additional disk \\(\\d+\\) ' +
                    'exceeds the server\'s available disk \\(-?\\d+\\)'),
                    'error message should explain additional disk required');
            } else {
                t.ok(false,
                    'body.errors should be an array with entries in it');
            }
        }

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

// A non-flexible-disk vm does not include the disk image (first disk) size in
// the calculation of the used quota (whilst flexible disk vm's do include this)
// so when changing from non-flex to flex, we need to make sure it will not
// exceed the total flexible disk size.
exports.error_for_resize_when_disk_usage_exceeds_flex_size = function (t) {
    if (!vmLocation) {
        t.ok(false, 'Skipping - no vm was created');
        t.done();
        return;
    }
    if (!pkgSampleSmallBhyveFlex) {
        t.ok(false, 'Skipping - no small flexible disk package was found');
        t.done();
        return;
    }

    var params = { action: 'update', billing_id: pkgSampleSmallBhyveFlex.uuid };

    var opts = createOpts(vmLocation + '?force=true', params);

    client.post(opts, params, function (err, req, res, body) {
        t.ok(err, 'expected error POSTing resize');
        t.equal(res.statusCode, 409, 'expected HTTP code 409');
        t.equal(body.code, 'ValidationFailed',
            'expected ValidationFailed error');
        t.equal(body.message, 'Cannot resize bhyve instance, existing disk ' +
            'usage (30720) exceeds the flexible disk size (24576)');
        t.done();
    });
};

// Now there should be enough space to convert to a flexible disk instance.
exports.resize_vm_to_flexible_disk = function (t) {
    if (!vmLocation) {
        t.ok(false, 'Skipping - no vm was created');
        t.done();
        return;
    }
    if (!pkgSampleBhyveFlex) {
        t.ok(false, 'Skipping - no flexible disk package was found');
        t.done();
        return;
    }

    var params = { action: 'update', billing_id: pkgSampleBhyveFlex.uuid };

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

// It should NOT be possible to change/resize back to a non-flexible disk
// package.
exports.resize_vm_non_flexible_disk_gets_error = function (t) {
    if (!vmLocation) {
        t.ok(false, 'Skipping - no vm was created');
        t.done();
        return;
    }
    if (!pkgSample1G) {
        t.ok(false, 'Skipping - no sample-1G package was found');
        t.done();
        return;
    }

    var params = { action: 'update', billing_id: pkgSample1G.uuid };
    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
        t.ok(err, 'expected error POSTing resize');
        t.equal(res.statusCode, 409, 'expected HTTP code 409');
        t.equal(body.code, 'ValidationFailed',
            'expected ValidationFailed error');
        t.equal(body.message, 'Cannot resize bhyve instance to a package ' +
            'that does not use flexible disk',
            'expected invalid non-flex disk resize message');
        t.done();
    });
};


// It should NOT be possible to change/resize to a flexible disk size that is
// too small to contain the current disks/snapshots.
exports.resize_vm_down_too_small_gets_error = function (t) {
    if (!vmLocation) {
        t.ok(false, 'Skipping - no vm was created');
        t.done();
        return;
    }
    if (!pkgSample1G) {
        t.ok(false, 'Skipping - no sample-1G package was found');
        t.done();
        return;
    }

    var params = { action: 'update', billing_id: pkgSample1G.uuid };
    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
        t.ok(err, 'expected error POSTing resize');
        t.equal(res.statusCode, 409, 'expected HTTP code 409');
        t.equal(body.code, 'ValidationFailed',
            'expected ValidationFailed error');
        t.equal(body.message, 'Cannot resize bhyve instance to a package ' +
            'that does not use flexible disk',
            'expected invalid non-flex disk resize message');
        t.done();
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
