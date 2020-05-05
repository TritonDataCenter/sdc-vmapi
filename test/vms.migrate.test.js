/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * Migration test plan overview:
 *  test bad actions (no migration, ...)
 *  provision test vm (which will later be migrated)
 *    test bad actions
 *  migrate begin
 *    test bad actions (starting migrate again...)
 *    abort (destroys the provisioned vm from begin)
 *  migrate begin
 *    test migrate watch
 *    migrate sync
 *      test migrate watch
 *    migrate sync again
 *    migrate switch
 *      test migrate watch
 *  migrate full (begin, sync, switch)
 *    test migrate watch
 *    migrate cleanup (delete original vm)
 *  test cleanup
 */

var util = require('util');

var assert = require('assert-plus');
var vasync = require('vasync');

var common = require('./common');
var testUuid = require('./lib/uuid');
var testMigration = require('./lib/migration');
var uuid = require('uuid');


/* Globals */

var ADMIN_USER_UUID = common.config.ufdsAdminUuid;
var PROVISION_NETWORKS = [];
var client;

function getUserScript(type) {
    var lines;

    // The idea is to create a new zfs dataset and mount it under the
    // delegate dataset.

    if (type === 'smartos') {
        lines = [
            '#!/usr/bin/bash',
            'echo "hi" > /var/tmp/todd-hi.txt',
            'export ZFS=/usr/sbin/zfs',
            'export ZONE=$(/usr/bin/zonename)'
        ];
    } else if (type === 'lx') {
        lines = [
            '#!/bin/bash',
            'export ZFS=/native/sbin/zfs',
            'export ZONE=$(/native/sbin/zonename)'
        ];
    } else {
        throw new Error('"' + type + '" does not support delegate datasets');
    }

    lines = lines.concat([
        'export > /var/tmp/todd-env.txt',
        'export FILESYSTEM="zones/${ZONE}/data/mydata"',
        '${ZFS} create "${FILESYSTEM}"',
        '${ZFS} set mountpoint=/data "${FILESYSTEM}"',
        '${ZFS} mount "${FILESYSTEM}"',
        'echo "hi" > /data/file.txt'
    ]);

    return lines.join('\n') + '\n';
}

var configurations = [
    {
        type: 'smartos',
        imageName: 'triton-origin-multiarch-15.4.1',
        packageName: 'sdc_64',
        vm: {
            alias: 'vmapitest-migrate-' + testUuid.generateShortUuid(),
            brand: 'joyent-minimal',
            owner_uuid: ADMIN_USER_UUID,
            tags: {
                'triton.placement.exclude_virtual_servers': true
            },
            // TRITON-1986 Create a delegate dataset.
            delegate_dataset: true,
            customer_metadata: {
                'user-script': getUserScript('smartos')
            }
        }
    },
    {
        type: 'lx',
        imageName: 'ubuntu-16.04',
        packageName: 'sample-256M',
        vm: {
            alias: 'vmapitest-migrate-' + testUuid.generateShortUuid(),
            brand: 'lx',
            owner_uuid: ADMIN_USER_UUID,
            tags: {
                'triton.placement.exclude_virtual_servers': true
            },
            // TRITON-1986 Create a delegate dataset.
            delegate_dataset: true,
            customer_metadata: {
                'user-script': getUserScript('lx')
            }
        }
    },
    {
        type: 'docker',
        // Note that this is not a true docker image, but it's close enough
        // for testing purposes.
        imageName: 'ubuntu-16.04',
        packageName: 'sample-256M',
        vm: {
            alias: 'vmapitest-migrate-' + testUuid.generateShortUuid(),
            brand: 'lx',
            docker: true,
            kernel_version: '3.13.0',
            internal_metadata: {
                'docker:cmd': '["sh","-c","sleep 86400"]',
                'docker:env': '["PATH=/usr/local/sbin:/usr/local/bin:' +
                    '/usr/sbin:/usr/bin:/sbin:/bin"]',
                'docker:volumesfrom': '[]'
            },
            owner_uuid: ADMIN_USER_UUID,
            tags: {
                'sdc-docker': true
            },
            // TRITON-1726 Create a docker data volume.
            filesystems: [
                {
                    source: uuid.v4(),
                    target: '/data/db',
                    type: 'lofs',
                    options: []
                }
            ]
        }
    },
    {
        type: 'bhyve',
        imageName: 'ubuntu-certified-16.04',
        packageName: 'sample-bhyve-flexible-1G',
        vm: {
            alias: 'vmapitest-migrate-' + testUuid.generateShortUuid(),
            brand: 'bhyve',
            owner_uuid: ADMIN_USER_UUID,
            tags: {
                'triton.placement.exclude_virtual_servers': true
            }
        }
    },
    {
        type: 'kvm',
        imageName: 'ubuntu-certified-16.04',
        packageName: 'sample-2G',
        vm: {
            alias: 'vmapitest-migrate-' + testUuid.generateShortUuid(),
            brand: 'kvm',
            owner_uuid: ADMIN_USER_UUID,
            tags: {
                'triton.placement.exclude_virtual_servers': true
            }
        }
    }
];

exports.setUp = function (callback) {
    if (client) {
        callback();
        return;
    }
    common.setUp(function (err, _client) {
        assert.ifError(err);
        assert.ok(_client, 'restify client');
        client = _client;
        callback();
    });
};

/* Tests */

exports.get_provision_network = function test_get_provision_network(t) {
    client.napi.get('/fabrics/' + ADMIN_USER_UUID + '/vlans',
            function (err, req, res, vlans) {
        if (err) {
            // When fabrics are disabled, we get a PreconditionRequiredError.
            if (err.restCode === 'PreconditionRequiredError') {
                t.ok(true, 'Fabric networking is not enabled');
            } else {
                t.ok(false, 'Error listing fabric vlans: ' + err);
            }

            lookupExternalNetwork();
            return;
        }

        lookupFabricNetwork();
    });

    function lookupFabricNetwork() {
        client.napi.get('/networks?owner_uuid=' + ADMIN_USER_UUID +
            '&fabric=true',
                function (err, req, res, networks) {
            // console.dir(networks);
            common.ifError(t, err, 'lookup admin fabric network');
            t.equal(res.statusCode, 200, '200 OK');
            t.ok(networks, 'networks is set');
            t.ok(Array.isArray(networks), 'networks is Array');
            t.ok(networks.length === 1, '1 network found');

            t.ok(networks[0], 'Admin fabric network should be found');
            if (Array.isArray(networks) && networks.length >= 1) {
                PROVISION_NETWORKS = [
                    { uuid: networks[0].uuid },
                    { uuid: networks[0].uuid }
                ];
                t.done();
                return;
            }

            lookupExternalNetwork();
        });
    }

    function lookupExternalNetwork() {
        assert.equal(PROVISION_NETWORKS.length, 0,
            'Should be no provision networks set');

        client.napi.get('/networks?nic_tag=external',
                function _getExternalNetworks(err, req, res, networks) {
            common.ifError(t, err);
            t.equal(res.statusCode, 200, '200 OK');
            t.ok(networks, 'networks is set');
            t.ok(Array.isArray(networks), 'networks is Array');
            t.ok(networks.length >= 1, 'at least 1 external network found');

            if (Array.isArray(networks) && networks.length >= 1) {
                PROVISION_NETWORKS = [ {uuid: networks[0].uuid} ];
            }

            t.done();
        });
    }
};


exports.bad_migrate_core_zone = function (t) {
    // Should not be able to migrate a triton core zone.
    vasync.pipeline({arg: {}, funcs: [
        function findCoreZone(ctx, next) {
            client.get({
                path: '/vms?tag.smartdc_type=core&state=active&limit=1'
            }, function onFindCoreZone(err, req, res, body) {
                if (err) {
                    t.ok(false, 'unable to query vmapi for core zone: ' +
                        err);
                    next(true);
                    return;
                }
                if (!body || !body[0] || !body[0].uuid) {
                    t.ok(false, 'no core zone found');
                    next(true);
                    return;
                }
                ctx.vm = body[0];
                next();
            });
        },

        function migrateCoreZone(ctx, next) {
            client.post({
                path: util.format(
                    '/vms/%s?action=migrate&migration_action=begin',
                    ctx.vm.uuid)
            }, function onMigrateCoreZoneCb(err) {
                t.ok(err, 'expect an error for migration of a core zone');
                if (err) {
                    t.equal(err.statusCode, 412,
                        util.format('err.statusCode === 412, got %s',
                            err.statusCode));
                }
                next();
            });
        }
    ]}, function _pipelineCb() {
        t.done();
    });
};


exports.config_setup = function configSetup(t) {
    var packages;

    vasync.forEachPipeline({
        inputs: configurations,
        func: function _setupOneConfig(cfg, cb) {
            t.ok('setup one config', 'setup one config');
            assert.object(cfg, 'cfg');
            assert.string(cfg.type, 'cfg.type');
            assert.string(cfg.packageName, 'cfg.packageName');
            assert.object(cfg.vm, 'cfg.vm');

            cfg.vm.networks = PROVISION_NETWORKS;

            vasync.pipeline({funcs: [
                function loadPackages(_, next) {
                    if (packages) {
                        next();
                        return;
                    }
                    client.papi.get('/packages',
                            function getPackages(err, req, res, packages_) {
                        common.ifError(t, err, 'getting packages');
                        packages = packages_;
                        next();
                    });
                },
                function lookupPackage(_, next) {
                    var packageMatches = packages.filter(function (p) {
                        return p.name === cfg.packageName;
                    });
                    t.ok(packageMatches.length > 0,
                        'should find package named: ' + cfg.packageName);
                    if (packageMatches.length > 0) {
                        cfg.vm.billing_id = packageMatches[0].uuid;
                    }
                    next();
                    return;
                },
                function lookupImage(_, next) {
                    if (!cfg.imageName) {
                        next();
                        return;
                    }
                    client.imgapi.get('/images?name=' + cfg.imageName +
                        '&state=active',
                            function getImg(err, req, res, imgs) {
                        common.ifError(t, err, 'err');
                        t.ok(imgs.length, 'imgs.length');

                        var newestImg = imgs.sort(function byDate(a, b) {
                            return a.published_at < b.published_at ? 1 : -1;
                        })[0];

                        if (['kvm', 'bhyve'].indexOf(cfg.type) >= 0) {
                            cfg.vm.disks = [ {
                                boot: true,
                                image_uuid: newestImg.uuid,
                                model: 'virtio'
                            } ];
                        } else {
                            cfg.vm.image_uuid = newestImg.uuid;
                        }
                        next();
                    });
                }
            ]}, cb);
        }
    }, function _onConfigSetup(err) {
        common.ifError(t, err, 'config setup');
        t.done();
    });
};

configurations.forEach(function _forEachConfig(cfg) {
    var suite = exports[cfg.type] = {};

    testMigration.TestMigrationCfg(suite, cfg);
});
