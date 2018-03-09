/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var VError = require('verror').VError;

var safeBrandName = require('../lib/common/validation')._safeBrandName;
var validatePackageValues =
    require('../lib/common/validation')._validatePackageValues;

var PACKAGES = {
    'BHYVE_PACKAGE': {
        brand: 'bhyve',
        cpu_cap: 100,
        max_lwps: 4000,
        max_physical_memory: 1024,
        max_swap: 2048,
        name: 'BHYVE_PACKAGE',
        quota: 10240,
        uuid: '62c59acd-456e-49e9-a3b2-bc707928624f',
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
        uuid: 'f76066d9-8a26-46d8-b49b-7db693be5073',
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
        uuid: '592d392b-4792-4e83-8bc7-cee6506f9abb',
        vcpus: 2,
        zfs_io_priority: 100
    }
};

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
        t.ok(!err, 'package should be valid when it has no brand');
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
        t.ok(!err, 'package should be valid when brand matches provision');
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
        t.ok(err,
            'package should be invalid when brand does not match provision');
        t.equal(err.field, 'brand', 'field with problem should be "brand"');
        t.equal(err.code, 'Invalid', 'error code should be "Invalid"');
        t.equal(err.message,
            'Package requires brand "bhyve", but brand "kvm" was specified',
            'error message should indicate package and brand conflict');

        // errs is only populated in rare cases. Not including this one.
        t.deepEqual(errs, [],
            'errs should be empty after brand does not match provision');

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
