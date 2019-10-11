/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

var assert = require('assert-plus');
var uuid = require('uuid');

var VError = require('verror').VError;

var mod_validation = require('../lib/common/validation');

var safeBrandName = mod_validation._safeBrandName;
var validatePackageValues = mod_validation.validatePackageValues;
var validateUpdateVmParams = mod_validation.validateUpdateVmParams;

var PACKAGES = {
    'BHYVE_PACKAGE': {
        brand: 'bhyve',
        cpu_cap: 100,
        max_lwps: 4000,
        max_physical_memory: 1024,
        max_swap: 2048,
        name: 'BHYVE_PACKAGE',
        quota: 10240,
        uuid: uuid.v4(),
        vcpus: 2,
        zfs_io_priority: 100
    },
    'BHYVE_FLEX_PACKAGE': {
        brand: 'bhyve',
        cpu_cap: 100,
        max_lwps: 4000,
        max_physical_memory: 1024,
        max_swap: 2048,
        name: 'BHYVE_FLEX_PACKAGE',
        flexible_disk: true,
        quota: 10240,
        uuid: uuid.v4(),
        vcpus: 2,
        zfs_io_priority: 100
    },
    'BHYVE_FLEX_LARGER_MEM_PACKAGE': {
        brand: 'bhyve',
        cpu_cap: 100,
        max_lwps: 4000,
        max_physical_memory: 1024 + 1024,
        max_swap: 4096,
        name: 'BHYVE_FLEX_LARGER_MEM_PACKAGE',
        flexible_disk: true,
        quota: 10240,
        uuid: uuid.v4(),
        vcpus: 2,
        zfs_io_priority: 100
    },
    'BHYVE_FLEX_LARGER_QUOTA_PACKAGE': {
        brand: 'bhyve',
        cpu_cap: 100,
        max_lwps: 4000,
        max_physical_memory: 1024,
        max_swap: 2048,
        name: 'BHYVE_FLEX_LARGER_QUOTA_PACKAGE',
        flexible_disk: true,
        quota: 10240 + 10240,
        uuid: uuid.v4(),
        vcpus: 2,
        zfs_io_priority: 100
    },
    'JOYENT_PACKAGE': {
        cpu_cap: 100,
        max_lwps: 4000,
        max_physical_memory: 1024,
        max_swap: 2048,
        name: 'JOYENT_PACKAGE',
        quota: 10240,
        uuid: uuid.v4(),
        zfs_io_priority: 100
    },
    'KVM_PACKAGE': {
        brand: 'kvm',
        cpu_cap: 100,
        max_lwps: 4000,
        max_physical_memory: 1024,
        max_swap: 2048,
        name: 'KVM_PACKAGE',
        quota: 10240,
        uuid: uuid.v4(),
        vcpus: 2,
        zfs_io_priority: 100
    }
};

// Ensure all packages use a unique name and uuid.
Object.keys(PACKAGES).forEach(function checkUniqueUuid(pkgName) {
    var sameUuid = Object.keys(PACKAGES).filter(function (name) {
        return PACKAGES[name].uuid === PACKAGES[pkgName].uuid;
    });
    assert.equal(sameUuid.length, 1);

    var sameName = Object.keys(PACKAGES).filter(function (name) {
        return name === pkgName || PACKAGES[name].name === pkgName;
    });
    assert.equal(sameName.length, 1);
});

function ifError(t, err, prefix) {
    t.ok(!err,
        (prefix ? prefix + ': ' : '') +
        (err ? ('error: ' + err.message) : 'no error'));
}

function DummyPapi() {
    var self = this;

    var idx;
    var pkg;
    var pkgKeys = Object.keys(PACKAGES);

    self.packages = {};

    for (idx = 0; idx < pkgKeys.length; idx++) {
        pkg = PACKAGES[pkgKeys[idx]];
        self.packages[pkg.uuid] = pkg;
    }
}

DummyPapi.prototype.getPackage = function getPackage(pkgUuid, callback) {
    var self = this;

    if (self.packages[pkgUuid] === undefined) {
        callback(new VError({
            name: 'ResourceNotFoundError'
        }, 'Package does not exist'));
        return;
    }

    callback(null, self.packages[pkgUuid]);
};

DummyPapi.prototype.addPackage = function addPackage(pkg) {
    this.packages[pkg.uuid] = pkg;
};

// This tests that our mock "getPackage" works in the case where a package
// doesn't exist.
exports.check_missing_package = function check_missing_package(t) {
    var errs = [];

    validatePackageValues(new DummyPapi(), {
        billing_id: 'a7dae0a8-933b-4d74-8b41-c81fb4c792d5',
        brand: 'joyent'
    }, errs, function _onValidated(err) {
        t.ok(!err, 'should be no err when package does not exist');
        t.deepEqual(errs, [ {
            code: 'Invalid',
            field: 'billing_id',
            message: 'Package does not exist'
        } ], 'should be error in errs when package does not exist');
        t.done();
    });
};

// This is the common case: package has no brand
exports.check_no_package_brand = function check_no_package_brand(t) {
    var errs = [];

    validatePackageValues(new DummyPapi(), {
        billing_id: PACKAGES['JOYENT_PACKAGE'].uuid,
        brand: 'joyent'
    }, errs, function _onValidated(err) {
        t.ok(!err, 'should be no err validating: err=' + err);
        t.deepEqual(errs, [],
            'should be no errors when package has no brand');
        t.done();
    });
};

// In this case, package.brand matches payload.brand
exports.check_valid_package_brand = function check_valid_package_brand(t) {
    var errs = [];

    validatePackageValues(new DummyPapi(), {
        billing_id: PACKAGES['BHYVE_PACKAGE'].uuid,
        brand: 'bhyve'
    }, errs, function _onValidated(err) {
        t.ok(!err, 'should be no err validating: err=' + err);
        t.deepEqual(errs, [],
            'should be no errors when brand matches provision');
        t.done();
    });
};

// In this case, package.brand differs from payload.brand
exports.check_invalid_package_brand = function check_invalid_package_brand(t) {
    var errs = [];

    validatePackageValues(new DummyPapi(), {
        billing_id: PACKAGES['BHYVE_PACKAGE'].uuid,
        brand: 'kvm'
    }, errs, function _onValidated(err) {
        t.ok(!err, 'should be no err validating: err=' + err);
        t.deepEqual(errs, [ {
            code: 'Invalid',
            field: 'brand',
            message: 'Package requires brand "bhyve", but brand "kvm" was '
                + 'specified'
        } ], 'should be error in errs when package brand does not match');
        t.done();
    });
};

exports.test_safe_brand_name = function test_safe_brand_name(t) {
    // When we stop using nodeunit (it appears to eat assert-plus asserts)
    // we should also test that this throws on non-string input.
    //
    // E.g.:
    //
    //  // undefined should blow the assert.string
    //  t.throws(function _garbageInUndefined() {
    //      safeBrandName(undefined);
    //  }, /brandName \(string\) is required/,
    //      'undefined should blow safeBrandName assert.string');
    //
    //  // any object should blow the assert.string
    //  t.throws(function _garbageInObject() {
    //      safeBrandName({'S-Mart': 'BOOMSTICK'});
    //  }, /brandName \(string\) is required/,
    //      'object should blow safeBrandName assert.string');
    //

    t.equal(safeBrandName('joyent-minimal'), 'joyent-minimal',
        'joyent-minimal should be untouched');
    t.equal(safeBrandName('hash#tag'), 'hashtag',
        'should remove "#" character');
    t.equal(safeBrandName(
        // input
        'abcdefghijklmnopqrstuvwxyz' +
        'abcdefghijklmnopqrstuvwxyz' +
        'abcdefghijklmnopqrstuvwxyz'),
        // output
        'abcdefghijklmnopqrstuvwxyz' +
        'abcdefghijklmnopqrstuvwxyz' +
        'abcdefghijkl',
        'long name should be truncated to 64 characters');

    t.done();
};


function createDummyApp(opts) {
    return {
        cnapi: {
            capacity: function (serverUuids, cb) {
                var capacities = {};

                serverUuids.forEach(function (server_uuid) {
                    var capSettings = opts && opts.capacity || {};
                    var entry = {
                        ram: capSettings.ram || 100000,
                        disk: capSettings.disk || 100000
                    };
                    capacities[server_uuid] = entry;
                });

                cb(null, {capacities: capacities});
            }
        },
        imgapi: {
            getImage: function fakeGetImage(image_uuid, cb) {
                // Validation is checking against the image.requirements, so we
                // just return an empty image with empty image.requirements.
                cb(null, { requirements: {} });
            }
        },
        log: {
            trace: function () {},
            debug: function () {},
            info: function () {},
            warn: function () {},
            error: function () {}
        },
        papi: new DummyPapi()
    };
}

function createDummyBhyveVm(props) {
    var vm = {
        brand: 'bhyve',
        hvm: true,
        state: 'running',
        quota: 10,
        disks: [
            {
                image_uuid: 'fake',
                size: 10240
            }
        ],
        uuid: uuid.v4(),
        server_uuid: uuid.v4()
    };

    var pkgName = props.package;
    delete props.package;

    // Copy over package properties.
    if (pkgName) {
        var pkg = PACKAGES[pkgName];

        // Start the vm with the properties from the base pkg.
        Object.keys(pkg).forEach(function (field) {
            if (['name', 'uuid'].indexOf(field) !== -1) {
                return;
            }
            if (field === 'flexible_disk' && pkg[field]) {
                vm.flexible_disk_size = pkg.quota;
                return;
            }
            vm[field] = pkg[field];
        });

        // Fixup for quota for flexible disk.
        if (pkg.flexible_disk) {
            vm.quota = 10;
        }

        // Copy max_physical_memory to ram setting.
        if (pkg.max_physical_memory) {
            vm.ram = pkg.max_physical_memory;
        }
    }

    // Copy over vm properties.
    Object.keys(props).forEach(function (field) {
        vm[field] = props[field];
    });

    return vm;
}


// Ensure that validation will convert package max_physical_memory to ram.
exports.test_resize_convert_ram = function test_resize_convert_ram(t) {

    var app = createDummyApp();
    var vm = createDummyBhyveVm({
        package: 'BHYVE_FLEX_PACKAGE',
        state: 'stopped'
    });
    var params = {
        billing_id: PACKAGES['BHYVE_FLEX_LARGER_MEM_PACKAGE'].uuid
    };

    validateUpdateVmParams(app, vm, params, function (err, newparams) {
        t.ok(!err, 'resize of running bhyve vm when no cpu/mem change');
        t.equal(newparams.ram,
            PACKAGES['BHYVE_FLEX_LARGER_MEM_PACKAGE'].max_physical_memory,
            'max_physical_memory should be converted to ram');
        t.equal(newparams.max_physical_memory, undefined,
            'max_physical_memory should not be visible');
        t.done();
    });
};

// Check that we can resize running bhyve when cpu/mem does not change.
exports.test_resize_running_mem_cpu_not_changed =
function test_resize_running_mem_cpu_not_changed(t) {

    var app = createDummyApp();
    var vm = createDummyBhyveVm({package: 'BHYVE_FLEX_PACKAGE'});
    var params = {
        quota: vm.flexible_disk_size + 1024
    };

    validateUpdateVmParams(app, vm, params, function (err) {
        t.ok(!err, 'resize of running bhyve vm when no cpu/mem change');
        t.done();
    });
};

// Check that we can't resize running bhyve when cpu/mem changes - as the vm
// must be stopped.
exports.test_resize_running_mem_cpu_changed =
function test_resize_running_mem_cpu_changed(t) {

    var app = createDummyApp();
    var vm = createDummyBhyveVm({package: 'BHYVE_FLEX_PACKAGE'});
    var params = {
        max_physical_memory: vm.max_physical_memory + 1024
    };

    validateUpdateVmParams(app, vm, params, function (err) {
        t.ok(err, 'expect error for bhyve resize with changed mem');
        if (err) {
            var msg = 'VM not stopped: changing bhyve CPU or memory ' +
                'requires the instance to be stopped';
            t.deepEqual(err, {
                    jse_shortmsg: '',
                    jse_info: {},
                    message: msg,
                    statusCode: 409,
                    body: { code: 'VmNotStopped', message: msg },
                    restCode: 'VmNotStopped' },
                'should get an VM not stopped error');
        }
        t.done();
    });
};

// Check that we can resize stopped bhyve even if the cpu/mem changes.
exports.test_resize_stopped_mem_cpu_changed =
function test_resize_stopped_mem_cpu_changed(t) {

    var app = createDummyApp();
    var vm = createDummyBhyveVm({
        package: 'BHYVE_FLEX_PACKAGE',
        state: 'stopped'
    });
    var params = {
        max_physical_memory: vm.max_physical_memory + 1024
    };

    validateUpdateVmParams(app, vm, params, function (err) {
        ifError(t, err);
        t.done();
    });
};

// Check that we can resize running bhyve when pkg cpu/mem does not change.
exports.test_resize_running_pkg_mem_cpu_unchanged =
function test_resize_running_pkg_mem_cpu_unchanged(t) {

    var app = createDummyApp();
    var vm = createDummyBhyveVm({package: 'BHYVE_FLEX_PACKAGE'});
    var params = {
        billing_id: PACKAGES['BHYVE_FLEX_LARGER_QUOTA_PACKAGE'].uuid
    };

    validateUpdateVmParams(app, vm, params, function (err) {
        ifError(t, err);
        t.done();
    });
};

// Check that we can't resize running bhyve when package cpu/mem changes
// as the vm must be stopped.
exports.test_resize_running_pkg_mem_cpu_changed =
function test_resize_running_pkg_mem_cpu_changed(t) {

    var app = createDummyApp();
    var vm = createDummyBhyveVm({package: 'BHYVE_FLEX_PACKAGE'});
    var params = {
        billing_id: PACKAGES['BHYVE_FLEX_LARGER_MEM_PACKAGE'].uuid
    };

    validateUpdateVmParams(app, vm, params, function (err) {
        t.ok(err, 'expect error for bhyve resize with changed mem');
        if (err) {
            var msg = 'VM not stopped: changing bhyve CPU or memory ' +
                'requires the instance to be stopped';
            t.deepEqual(err, {
                    jse_shortmsg: '',
                    jse_info: {},
                    message: msg,
                    statusCode: 409,
                    body: { code: 'VmNotStopped', message: msg },
                    restCode: 'VmNotStopped' },
                'should get an VM not stopped error');
        }
        t.done();
    });
};

// Check that we can resize stopped bhyve even when the pkg cpu/mem changes.
exports.test_resize_stopped_pkg_mem_cpu_changed =
function test_resize_stopped_pkg_mem_cpu_changed(t) {

    var app = createDummyApp();
    var vm = createDummyBhyveVm({
        package: 'BHYVE_FLEX_PACKAGE',
        state: 'stopped'
    });
    var params = {
        billing_id: PACKAGES['BHYVE_FLEX_LARGER_MEM_PACKAGE'].uuid
    };

    validateUpdateVmParams(app, vm, params, function (err) {
        ifError(t, err);
        t.done();
    });
};


// Test that we can move from non-flexible disk package to a flexible disk one.
exports.test_resize_bhyve_to_flex_disk =
function test_resize_bhyve_to_flex_disk(t) {

    var app = createDummyApp();
    var vm = createDummyBhyveVm({
        package: 'BHYVE_PACKAGE'
    });

    var params = {
        billing_id: PACKAGES['BHYVE_FLEX_PACKAGE'].uuid
    };

    validateUpdateVmParams(app, vm, params, function (err, newparams) {
        ifError(t, err);
        t.ok(newparams, 'validateUpdateVmParams returned new params');

        if (newparams) {
            t.equal(newparams.flexible_disk_size,
                PACKAGES['BHYVE_FLEX_PACKAGE'].quota,
                'validateUpdateVmParams should set flexible_disk_size');
        }

        t.done();
    });
};


// Test that we cannot move from flexible disk to non-flexible disk package.
exports.test_resize_bhyve_away_from_flex_disk =
function test_resize_bhyve_away_from_flex_disk(t) {

    var app = createDummyApp();
    var vm = createDummyBhyveVm({
        package: 'BHYVE_FLEX_PACKAGE'
    });

    var params = {
        billing_id: PACKAGES['BHYVE_PACKAGE'].uuid
    };

    validateUpdateVmParams(app, vm, params, function (err) {
        t.ok(err, 'expect error for bhyve resize away from flex disk package');
        if (err) {
            var msg = 'Cannot resize bhyve instance to a package that does ' +
                'not use flexible disk';
            t.deepEqual(err, {
                    jse_shortmsg: '',
                    jse_info: {},
                    message: msg,
                    statusCode: 409,
                    body: {
                        code: 'ValidationFailed',
                        message: msg,
                        errors: [ { field: 'billing_id',
                            code: 'Invalid',
                            message: 'Invalid parameter' } ]
                    },
                    restCode: 'ValidationFailed' },
                'should get a validation failed error');
        }
        t.done();
    });
};

// Test that we cannot resize to use more space than what is available for
// flexible disk instances.
exports.test_resize_bhyve_not_enough_disk_capacity =
function test_resize_bhyve_not_enough_disk_capacity(t) {

    var app = createDummyApp({capacity: {disk: 4 * 1024}});
    var vm = createDummyBhyveVm({
        package: 'BHYVE_FLEX_PACKAGE'
    });
    var params = {
        billing_id: PACKAGES['BHYVE_FLEX_LARGER_QUOTA_PACKAGE'].uuid
    };

    validateUpdateVmParams(app, vm, params, function (err) {
        t.ok(err, 'expect error for bhyve resize away from flex disk package');
        if (err) {
            t.deepEqual(err, {
                    jse_shortmsg: '',
                    jse_info: {},
                    message: 'Invalid VM update parameters',
                    statusCode: 409,
                    body: {
                        code: 'ValidationFailed',
                        message: 'Invalid VM update parameters',
                        errors: [ {
                            field: 'quota',
                            code: 'InsufficientCapacity',
                            message: 'Required additional disk (10) exceeds ' +
                                'the server\'s available disk (4)'
                        } ]
                    },
                    restCode: 'ValidationFailed' },
                'should get a validation failed error');
        }
        t.done();
    });
};

// Test that we can resize when there is just space available.
exports.test_resize_bhyve_just_enough_capacity =
function test_resize_bhyve_just_enough_capacity(t) {

    var app = createDummyApp({capacity: {
        disk: (PACKAGES['BHYVE_FLEX_LARGER_QUOTA_PACKAGE'].quota -
            PACKAGES['BHYVE_FLEX_PACKAGE'].quota) * 1024
    }});
    var vm = createDummyBhyveVm({
        package: 'BHYVE_FLEX_PACKAGE'
    });
    var params = {
        billing_id: PACKAGES['BHYVE_FLEX_LARGER_QUOTA_PACKAGE'].uuid
    };

    validateUpdateVmParams(app, vm, params, function (err) {
        t.ok(!err, 'no error expected when there is just enough capacity');
        t.done();
    });
};

// Test that we cannot resize from non-flexible-disk if the resulting disk
// size total exceeds the available flexible disk size.
exports.test_resize_bhyve_disks_larger =
function test_resize_bhyve_disks_larger(t) {

    var app = createDummyApp();
    var vm = createDummyBhyveVm({
        package: 'BHYVE_PACKAGE',
        disks: [
            {
                image_uuid: 'fake',
                size: 10 * 1024
            },
            {
                size: 15 * 1024
            }
        ]
    });

    var params = {
        billing_id: PACKAGES['BHYVE_FLEX_PACKAGE'].uuid
    };

    // Double check that the disk usage has been exceeded.
    var diskUsage = vm.disks.map(function (disk) { return disk.size || 0; }).
        reduce(function (size, runningTotal) {
            return size + runningTotal;
        }, 0);
    t.ok(diskUsage > PACKAGES['BHYVE_FLEX_PACKAGE'].quota,
        'vm disk usage (' + diskUsage + ') should be higher than the ' +
        'package quota (' + PACKAGES['BHYVE_FLEX_PACKAGE'].quota + ')');

    validateUpdateVmParams(app, vm, params, function (err) {
        t.ok(err, 'expect error for bhyve resize where usage exceeds quota');
        if (err) {
            var msg = 'Cannot resize bhyve instance, existing disk usage ' +
                '(25600) exceeds the flexible disk size (10240)';
            t.deepEqual(err, {
                    jse_shortmsg: '',
                    jse_info: {},
                    message: msg,
                    statusCode: 409,
                    body: {
                        code: 'ValidationFailed',
                        message: msg,
                        errors: [ { field: 'flexible_disk_size',
                            code: 'Invalid',
                            message: 'Invalid parameter' } ]
                    },
                    restCode: 'ValidationFailed' },
                'should get a validation failed error');
        }
        t.done();
    });
};

// Test that we cannot resize up/down when the current total disk usage
// (including snapshots) exceeds the available flexible disk size.
exports.test_resize_bhyve_not_enough_space_with_snapshots =
function test_resize_bhyve_not_enough_space_with_snapshots(t) {

    var app = createDummyApp();
    var vm = createDummyBhyveVm({
        package: 'BHYVE_FLEX_LARGER_QUOTA_PACKAGE',
        snapshots: [
            {name: 'snap1', size: 5 * 1024},
            {name: 'snap2', size: 6 * 1024}
        ]
    });

    var params = {
        billing_id: PACKAGES['BHYVE_FLEX_PACKAGE'].uuid
    };

    var diskUsage = vm.disks.map(
        function (disk) {
            return disk.size || 0;
        }). reduce(function (size, runningTotal) {
            return size + runningTotal;
        }, 0);
    var newQuota = PACKAGES['BHYVE_FLEX_PACKAGE'].quota;
    t.ok(diskUsage <= newQuota,
        'vm disk usage (' + diskUsage + ') should be equal or lower than the ' +
        'package quota (' + newQuota + ')');

    var totalUsage = diskUsage + vm.snapshots.map(
        function (snap) {
            return snap.size || 0;
        }).reduce(function (size, runningTotal) {
            return size + runningTotal;
        }, 0);
    t.ok(totalUsage > newQuota,
        'vm disk usage (' + diskUsage + ') should be greater than the ' +
        'package quota (' + newQuota + ')');

    validateUpdateVmParams(app, vm, params, function (err) {
        t.ok(err, 'expect error for bhyve resize where usage exceeds quota');
        if (err) {
            var msg = 'Cannot resize bhyve instance, existing disk usage ' +
                '(' + totalUsage + ') exceeds the flexible disk size (' +
                newQuota + ')';
            t.deepEqual(err, {
                    jse_shortmsg: '',
                    jse_info: {},
                    message: msg,
                    statusCode: 409,
                    body: {
                        code: 'ValidationFailed',
                        message: msg,
                        errors: [ { field: 'flexible_disk_size',
                            code: 'Invalid',
                            message: 'Invalid parameter' } ]
                    },
                    restCode: 'ValidationFailed' },
                'should get a validation failed error');
        }
        t.done();
    });
};
