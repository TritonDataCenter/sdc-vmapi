/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

var assert = require('assert-plus');
var jsprim = require('jsprim');
var uuid = require('libuuid');

var common = require('./common');
var waitForValue = common.waitForValue;


// --- Globals


var CLIENT;
var VM_UUID;
var PCI_SLOTS = [];

var CUSTOMER_UUID = common.config.ufdsAdminUuid;
var DISK_UUID = '2de262f8-3aa1-11e9-b79e-d712c1fb6cee';
var VM_ALIAS_BASE = 'vmapitest-disk';
var VM_OPTS = {
    autoboot: false,
    owner_uuid: CUSTOMER_UUID,
    brand: 'bhyve',
    billing_id: '00000000-0000-0000-0000-000000000000',
    vcpus: 1,
    cpu_cap: 100,
    ram: 1024,
    disks: [ { image_uuid: '81c0ef69-e9d7-4e93-a15b-efd7ea9c9ee8' } ],
    networks: [],
    creator_uuid: CUSTOMER_UUID,
    tags: {
        'triton.placement.exclude_virtual_servers': true
    }
};
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
            'x-request-id': uuid.create(),
            'x-context': JSON.stringify({
                caller: CALLER,
                params: params || {}
            })
        }
    };
}


function createVm(t, vmOpts) {
    var opts = createOpts('/vms', vmOpts);

    CLIENT.post(opts, vmOpts, function postCb(err, req, res, job) {
        common.ifError(t, err, 'err');

        assert.object(job, 'job');
        assert.uuid(job.job_uuid, 'job.job_uuid');

        VM_UUID = job.vm_uuid;
        var path = '/jobs/' + job.job_uuid;

        waitForValue(path, 'execution', 'succeeded', {
            client: CLIENT
        }, function waitForValueCb(err2) {
            common.ifError(t, err2, 'err2');
            t.done();
        });
    });
}


function deleteVm(t) {
    CLIENT.del('/vms/' + VM_UUID, function delCb(err, req, res, job) {
        common.ifError(t, err, 'err');
        assert.object(job, 'job');
        assert.uuid(job.job_uuid, 'job.job_uuid');

        var path = '/jobs/' + job.job_uuid;
        waitForValue(path, 'execution', 'succeeded', {
            client: CLIENT
        }, function waitForValueCb(err2) {
            common.ifError(t, err2, 'err2');
            t.done();
        });
    });
}


// --- Tests


exports.setup = function setup(t) {
    common.setUp(function setUpCb(err, _client) {
        assert.ifError(err);
        assert.ok(_client, 'restify client');
        CLIENT = _client;

        CLIENT.napi.get('/networks', function getCb(err2, req, res, networks) {
            common.ifError(t, err2, 'err2');
            var admin = common.extractAdminAndExternalNetwork(networks).admin;

            VM_OPTS.networks.push({ uuid: admin.uuid });

            t.done();
        });
    });
};


exports.initialize_non_flexible_disk_vm =
function initialize_non_flexible_disk_vms(t) {
    var opts = jsprim.deepCopy(VM_OPTS);
    opts.alias = VM_ALIAS_BASE + '-' + process.pid;
    createVm(t, opts);
};


exports.attempt_to_add_disk = function attempt_to_add_disk(t) {
    var path = '/vms/' + VM_UUID + '?action=create_disk';
    var opts = { size: 1536 };

    CLIENT.post(path, opts, function postCb(err, req, res, job) {
        t.ok(err, 'err');
        t.equal(err.name, 'VmWithoutFlexibleDiskSizeError');
        t.done();
    });
};


exports.destroy_non_flexible_disk_vm = deleteVm;


exports.initialize_flexible_disk_vm = function initialize_flexible_disk_vm(t) {
    var opts = jsprim.deepCopy(VM_OPTS);
    opts.alias = VM_ALIAS_BASE + '-' + process.pid;
    opts.flexible_disk_size = 11264;
    createVm(t, opts);
};


exports.add_too_large_disk = function add_too_large_disk(t) {
    var path = '/vms/' + VM_UUID + '?action=create_disk';
    var opts = { size: 1536 };

    CLIENT.post(path, opts, function postCb(err, req, res, job) {
        t.ok(err, 'err');
        t.equal(err.name, 'InsufficientDiskSpaceError');
        t.done();
    });
};


exports.add_disk = function add_disk(t) {
    var path = '/vms/' + VM_UUID + '?action=create_disk';
    var opts = { size: 1024 };

    CLIENT.post(path, opts, function postCb(err, req, res, job) {
        common.ifError(t, err, 'err');

        assert.object(job, 'job');
        assert.uuid(job.job_uuid, 'job.job_uuid');

        var jobPath = '/jobs/' + job.job_uuid;
        waitForValue(jobPath, 'execution', 'succeeded', {
            client: CLIENT
        }, function waitForValueCb(err2) {
            common.ifError(t, err2, 'err2');
            t.done();
        });
    });
};


exports.check_added_disk = function check_added_disk(t) {
    var path = '/vms/' + VM_UUID;
    CLIENT.get(path, function getCb(err, req, res, vm) {
        common.ifError(t, err, 'err');

        var disks = vm.disks;
        t.equal(disks.length, 2);
        t.equal(disks[0].pci_slot, '0:4:0', '[0].pci_slot');
        t.equal(disks[0].size, 10240, '[0].size');
        t.equal(disks[1].pci_slot, '0:4:1', '[1].pci_slot');
        t.equal(disks[1].size, 1024, '[1].size');

        PCI_SLOTS = disks.map(function (d) { return d.pci_slot; });

        t.done();
    });
};


exports.add_additional_too_much_disk = function add_too_much_disk(t) {
    var path = '/vms/' + VM_UUID + '?action=create_disk';
    var opts = { size: 128 };

    CLIENT.post(path, opts, function postCb(err, req, res, job) {
        t.ok(err, 'err');
        t.equal(err.name, 'InsufficientDiskSpaceError');
        t.done();
    });
};


exports.resize_disk_down_without_flag =
function resize_disk_down_without_flag(t) {
    var path = '/vms/' + VM_UUID + '?action=resize_disk';
    var opts = {
        pci_slot: PCI_SLOTS[1],
        size: 512
    };

    CLIENT.post(path, opts, function postCb(err, req, res, body) {
        t.ok(err, 'err');
        t.equal(err.name, 'ValidationFailedError');
        t.equal(body.errors[0].message,
            'Reducing disk size is a dangerous operation');
        t.done();
    });
};


exports.resize_disk_down_with_flag = function resize_disk_down_with_flag(t) {
    var path = '/vms/' + VM_UUID + '?action=resize_disk';
    var opts = {
        pci_slot: PCI_SLOTS[1],
        size: 512,
        dangerous_allow_shrink: true
    };

    CLIENT.post(path, opts, function postCb(err, req, res, job) {
        common.ifError(t, err, 'err');

        assert.object(job, 'job');
        assert.uuid(job.job_uuid, 'job.job_uuid');

        var jobPath = '/jobs/' + job.job_uuid;
        waitForValue(jobPath, 'execution', 'succeeded', {
            client: CLIENT
        }, function waitForValueCb(err2) {
            common.ifError(t, err2, 'err2');
            t.done();
        });
    });
};


exports.check_resized_down_disk = function check_resized_down_disk(t) {
    var path = '/vms/' + VM_UUID;
    CLIENT.get(path, function getCb(err, req, res, vm) {
        common.ifError(t, err, 'err');

        var disks = vm.disks;
        t.equal(disks[0].size, 10240, '[0].size');
        t.equal(disks[1].size, 512, '[1].size');

        t.done();
    });
};


exports.resize_disk_up = function resize_disk_up(t) {
    var path = '/vms/' + VM_UUID + '?action=resize_disk';
    var opts = {
        pci_slot: PCI_SLOTS[1],
        size: 1024
    };

    CLIENT.post(path, opts, function postCb(err, req, res, job) {
        common.ifError(t, err, 'err');

        assert.object(job, 'job');
        assert.uuid(job.job_uuid, 'job.job_uuid');

        var jobPath = '/jobs/' + job.job_uuid;
        waitForValue(jobPath, 'execution', 'succeeded', {
            client: CLIENT
        }, function waitForValueCb(err2) {
            common.ifError(t, err2, 'err2');
            t.done();
        });
    });
};


exports.check_resized_up_disk = function check_resized_up_disk(t) {
    var path = '/vms/' + VM_UUID;
    CLIENT.get(path, function getCb(err, req, res, vm) {
        common.ifError(t, err, 'err');

        var disks = vm.disks;
        t.equal(disks[0].size, 10240, '[0].size');
        t.equal(disks[1].size, 1024, '[1].size');

        t.done();
    });
};


exports.resize_disk_up_too_far = function resize_disk_up_too_far(t) {
    var path = '/vms/' + VM_UUID + '?action=resize_disk';
    var opts = {
        pci_slot: PCI_SLOTS[1],
        size: 1536
    };

    CLIENT.post(path, opts, function postCb(err, req, res, body) {
        t.ok(err, 'err');
        t.equal(err.name, 'InsufficientDiskSpaceError');
        t.done();
    });
};


exports.delete_disk = function delete_disk(t) {
    var path = '/vms/' + VM_UUID + '?action=delete_disk';
    var opts = { pci_slot: PCI_SLOTS[1] };

    CLIENT.post(path, opts, function postCb(err, req, res, job) {
        common.ifError(t, err, 'err');

        assert.object(job, 'job');
        assert.uuid(job.job_uuid, 'job.job_uuid');

        var jobPath = '/jobs/' + job.job_uuid;
        waitForValue(jobPath, 'execution', 'succeeded', {
            client: CLIENT
        }, function waitForValueCb(err2) {
            common.ifError(t, err2, 'err2');
            t.done();
        });
    });
};

exports.check_deleted_disk = function check_deleted_disk(t) {
    var path = '/vms/' + VM_UUID;
    CLIENT.get(path, function getCb(err, req, res, vm) {
        common.ifError(t, err, 'err');

        var disks = vm.disks;
        t.equal(disks.length, 1);
        t.equal(disks[0].size, 10240, '[0].size');

        t.done();
    });
};


exports.add_disk_with_pci_slot = function add_disk_with_pci_slot(t) {
    var path = '/vms/' + VM_UUID + '?action=create_disk';
    var opts = {
        pci_slot: '0:4:5',
        size: 512
    };

    CLIENT.post(path, opts, function postCb(err, req, res, job) {
        common.ifError(t, err, 'err');

        assert.object(job, 'job');
        assert.uuid(job.job_uuid, 'job.job_uuid');

        var jobPath = '/jobs/' + job.job_uuid;
        waitForValue(jobPath, 'execution', 'succeeded', {
            client: CLIENT
        }, function waitForValueCb(err2) {
            common.ifError(t, err2, 'err2');
            t.done();
        });
    });
};


exports.check_added_disk_with_pci_slot =
function check_added_disk_with_pci_slot(t) {
    var path = '/vms/' + VM_UUID;
    CLIENT.get(path, function getCb(err, req, res, vm) {
        common.ifError(t, err, 'err');

        var disks = vm.disks;
        t.equal(disks.length, 2);
        t.equal(disks[0].pci_slot, '0:4:0', '[0].pci_slot');
        t.equal(disks[0].size, 10240, '[0].size');
        t.equal(disks[1].pci_slot, '0:4:5', '[1].pci_slot');
        t.equal(disks[1].size, 512, '[1].size');

        t.done();
    });
};


exports.add_disk_with_existing_pci_slot =
function add_disk_with_existing_pci_slot(t) {
    var path = '/vms/' + VM_UUID + '?action=create_disk';
    var opts = {
        pci_slot: '0:4:5',
        size: 256
    };

    CLIENT.post(path, opts, function postCb(err, req, res, body) {
        t.ok(err, 'err');

        t.equal(err.name, 'ValidationFailedError', 'err.name');
        t.equal(body.errors[0].field, 'pci_slot', 'field');
        t.equal(body.errors[0].message, 'Already in use', 'message');

        t.done();
    });
};


exports.add_disk_with_uuid = function add_disk_with_uuid(t) {
    var path = '/vms/' + VM_UUID + '?action=create_disk';
    var opts = {
        disk_uuid: DISK_UUID,
        size: 256
    };

    CLIENT.post(path, opts, function postCb(err, req, res, job) {
        common.ifError(t, err, 'err');

        assert.object(job, 'job');
        assert.uuid(job.job_uuid, 'job.job_uuid');

        var jobPath = '/jobs/' + job.job_uuid;
        waitForValue(jobPath, 'execution', 'succeeded', {
            client: CLIENT
        }, function waitForValueCb(err2) {
            common.ifError(t, err2, 'err2');
            t.done();
        });
    });
};


exports.check_added_disk_with_uuid =
function check_added_disk_with_uuid(t) {
    var path = '/vms/' + VM_UUID;
    CLIENT.get(path, function getCb(err, req, res, vm) {
        common.ifError(t, err, 'err');

        var disks = vm.disks;
        t.equal(disks.length, 3);
        t.equal(disks[0].pci_slot, '0:4:0', '[0].pci_slot');
        t.equal(disks[0].size, 10240, '[0].size');

        t.equal(disks[1].pci_slot, '0:4:5', '[1].pci_slot');
        t.equal(disks[1].size, 512, '[1].size');

        t.equal(disks[2].uuid, DISK_UUID, '[1].uuid');
        t.equal(disks[2].pci_slot, '0:4:1', '[1].pci_slot');
        t.equal(disks[2].size, 256, '[1].size');

        t.done();
    });
};


exports.add_disk_with_existing_uuid =
function add_disk_with_existing_uuid(t) {
    var path = '/vms/' + VM_UUID + '?action=create_disk';
    var opts = {
        disk_uuid: DISK_UUID,
        size: 128
    };

    CLIENT.post(path, opts, function postCb(err, req, res, body) {
        t.ok(err, 'err');

        t.equal(err.name, 'ValidationFailedError', 'err.name');
        t.equal(body.errors[0].field, 'disk_uuid', 'field');
        t.equal(body.errors[0].message, 'Already in use', 'message');

        t.done();
    });
};


exports.destroy_flexible_disk_vm = deleteVm;
