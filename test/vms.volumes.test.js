/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

var assert = require('assert-plus');
var uuid = require('libuuid');
var vasync = require('vasync');

var common = require('./common');
var waitForValue = common.waitForValue;

var client;

var ADMIN_USER_UUID = common.config.ufdsAdminUuid;
var ADMIN_FABRIC_NETWORK;
var VMAPI_ORIGIN_IMAGE_UUID;
var SERVER;
var TEST_VOLUMES_NAME_PREFIX = 'vmapitest-volumes-';

function getVmPayloadTemplate() {
    return {
        alias: 'vmapitest-volumes-' + uuid.create().split('-')[0],
        owner_uuid: ADMIN_USER_UUID,
        image_uuid: VMAPI_ORIGIN_IMAGE_UUID,
        server_uuid: SERVER.uuid,
        networks: [ { uuid: ADMIN_FABRIC_NETWORK.uuid } ],
        brand: 'joyent-minimal',
        billing_id: '00000000-0000-0000-0000-000000000000',
        ram: 64,
        quota: 10,
        /*
         * Not setting a cpu_cap here would break the ability for Triton to
         * provision any VM with a non-null cpu_cap, since a mix of capped and
         * cap-less VMs is not allowed by the allocation system.
         */
        cpu_cap: 10
    };
}

exports.setUp = function (callback) {
    common.setUp(function (err, _client) {
        assert.ifError(err);
        assert.ok(_client, 'restify client');
        client = _client;
        callback();
    });
};

exports.check_volapi_present = function (t) {
    client.sapi.get('/services?name=volapi',
        function onListServices(servicesListErr, req, res, services) {
            if (servicesListErr || !services || services.length === 0) {
                console.log('skipping tests suite since VOLAPI service is ' +
                    'not present');
                process.exit(0);
            } else {
                t.ok(true, 'VOLAPI service present');
                t.done();
            }
        });
};

exports.get_vmapi_origin_image = function (t) {
    var vmapiVmImgUuid;

    vasync.pipeline({funcs: [
        function getVmapiImg(ctx, next) {
            client.get('/vms?alias=vmapi&tag.smartdc_type=core',
                function onListVms(listVmsErr, req, res, vms) {
                    t.ifError(listVmsErr);
                    t.ok(vms, 'listing VMAPI core VMs should result in a ' +
                        'non-empty response');

                    vmapiVmImgUuid = vms[0].image_uuid;

                    next();
                });
        },

        function getOrigImg(ctx, next) {
            client.imgapi.get('/images/' + vmapiVmImgUuid,
                function onGetImage(getImgErr, req, res, image) {
                    t.ifError(getImgErr);
                    t.ok(image, 'Listing VMAPI\'s VM\'s image should result ' +
                        'in a non-empty response');

                    VMAPI_ORIGIN_IMAGE_UUID = image.origin;

                    next();
                });
        }
    ]}, function onVmapiOriginImgRetrieved(err) {
        t.ifError(err);
        t.done();
    });
};

exports.get_admin_fabric_network = function (t) {
    client.napi.get('/networks?owner_uuid=' + ADMIN_USER_UUID + '&fabric=true',
        function (err, req, res, networks) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        t.ok(networks, 'networks is set');
        t.ok(Array.isArray(networks), 'networks is Array');
        t.ok(networks.length === 1, '1 network found');

        ADMIN_FABRIC_NETWORK = networks[0];
        t.ok(ADMIN_FABRIC_NETWORK,
                'Admin fabric network should have been found');

        t.done();
    });
};

exports.find_headnode = function (t) {
    client.cnapi.get('/servers', function (err, req, res, servers) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        t.ok(servers, 'servers is set');
        t.ok(Array.isArray(servers), 'servers is Array');
        for (var i = 0; i < servers.length; i++) {
            if (servers[i].headnode === true) {
                SERVER = servers[i];
                break;
            }
        }
        t.ok(SERVER, 'server found');
        t.done();
    });
};

exports.create_vm_with_invalid_volumes_params = function (t) {
    var INVALID_VOLUMES_PARAMS = [
        null,
        [],
        [ {} ],
        [ {foo: 'bar'} ],
        [ {name: '---,*;'} ],
        [ {name: 'foo', mountpoint: 'invalidmountpoint'} ],
        [ {name: 'foo', mountpoint: '/bar', mode: 'invalidmode'} ]
    ];

    vasync.forEachPipeline({
        func: function provisionVmWithInvalidVol(volumesParam, next) {
            var vmPayload = getVmPayloadTemplate();

            vmPayload.volumes = volumesParam;

            client.post({
                path: '/vms'
            }, vmPayload, function onVmCreated(createVmErr, req, res, body) {
                var expectedResStatusCode = 409;

                t.ok(createVmErr, 'VM creation should error');
                t.equal(res.statusCode, expectedResStatusCode,
                    'HTTP status code should be ' + expectedResStatusCode);
                next();
            });
        },
        inputs: INVALID_VOLUMES_PARAMS
    }, function onAllInvalidVolParamsTestsDone(err) {
        t.done();
    });
};

exports.create_vm_with_valid_volumes_params = function (t) {
    var INVALID_VOLUMES_PARAMS = [
        [
            {
                name: TEST_VOLUMES_NAME_PREFIX + uuid.create().substr(0, 7),
                mountpoint: '/bar'
            }
        ],
        [
            {
                name: TEST_VOLUMES_NAME_PREFIX + uuid.create().substr(0, 7),
                mountpoint: '/bar',
                mode: 'ro'
            }
        ],
        [
            {
                name: TEST_VOLUMES_NAME_PREFIX + uuid.create().substr(0, 7),
                mountpoint: '/bar',
                mode: 'rw'
            }
        ]
    ];

    vasync.forEachPipeline({
        func: function provisionVmWithValidVol(volumesParam, nextVolParam) {
            var vmPayload = getVmPayloadTemplate();
            var vmProvisioningJobUuid;
            var vmUuid;
            var volumeName = volumesParam[0].name;
            var volumeUuid;

            vmPayload.volumes = volumesParam;

            vasync.pipeline({funcs: [
                function createVm(ctx, next) {
                    client.post({
                        path: '/vms'
                    }, vmPayload,
                        function onVmCreated(createVmErr, req, res, body) {
                            var expectedResStatusCode = 202;

                            if (body) {
                                vmProvisioningJobUuid = body.job_uuid;
                                vmUuid = body.vm_uuid;
                            }

                            t.ifError(createVmErr,
                                    'VM creation should not error');
                            t.equal(res.statusCode, expectedResStatusCode,
                                'HTTP status code should be ' +
                                    expectedResStatusCode);

                            next();
                        });
                },

                function waitForVmProvisioned(ctx, next) {
                    if (!vmProvisioningJobUuid) {
                        next();
                        return;
                    }

                    waitForValue('/jobs/' + vmProvisioningJobUuid, 'execution',
                        'succeeded',
                        { client: client, timeout: 4 * 60 * 1000 },
                        function onVmProvisioned(provisionErr) {
                            t.ifError(provisionErr,
                                    'VM should be provisioned successfully');

                            next();
                        });
                },

                function getVolumeUuid(ctx, next) {
                    client.volapi.get('/volumes?name=' + volumeName,
                        function onListVolumes(listVolErr, req, res, body) {
                            t.ifError(listVolErr, 'Listing volumes with name ' +
                                volumeName + ' should succeed');
                            if (body) {
                                volumeUuid = body[0].uuid;
                            }

                            next();
                        });
                },

                function checkVolumeProvisioned(ctx, next) {
                    waitForValue('/volumes/' + volumeUuid, 'state', 'ready',
                        { client: client.volapi },
                        function onVolCreated(volCreatErr) {
                            t.ifError(volCreatErr,
                                    'VM should be provisioned successfully');

                            next();
                        });
                },

                function deleteVm(ctx, next) {
                    client.del({
                        path: '/vms/' + vmUuid
                    }, function onVmDeleted(vmDelErr) {
                        t.ifError(vmDelErr, 'Deleting VM with UUID ' + uuid +
                            'should succeed');

                        next();
                    });
                },

                function waitForVmDeleted(ctx, next) {
                    waitForValue('/vms/' + vmUuid, 'state', 'destroyed', {
                        client: client
                    }, function onVmDeleted(vmDelErr) {
                        t.ifError(vmDelErr,
                                'VM should have been deleted successfully');

                        next();
                    });
                },

                function deleteVolume(ctx, next) {
                    client.volapi.del('/volumes/' + volumeUuid + '?force=true',
                        function onVolDeleted(volDelErr) {
                            t.ifError(volDelErr);

                            next();
                        });
                }
            ]}, function onTestValidVolParamDone(err) {
                nextVolParam();
            });
        },
        inputs: INVALID_VOLUMES_PARAMS
    }, function onAllInvalidVolParamsTestsDone(err) {
        t.done();
    });
};