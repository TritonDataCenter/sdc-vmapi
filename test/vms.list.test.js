/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var assert = require('assert-plus');

var async = require('async');

var common = require('./common');
var vmCommon = require('../lib/common/vm-common');
var validation = require('../lib/common/validation');

var client;
var MORAY = require('../lib/apis/moray');

var VMS_LIST_ENDPOINT = '/vms';

var VALID_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
var INVALID_UUID = 'invalid_uuid';

exports.setUp = function (callback) {
    common.setUp(function (err, _client) {
        assert.ifError(err);
        assert.ok(_client, 'restify client');
        client = _client;
        callback();
    });
};

exports.list_vms_offset_and_marker_not_ok = function (t) {
    var FAKE_VM_UUID = '00000000-0000-0000-0000-000000000000';
    var queryString = '/vms?offset=1&marker=' + FAKE_VM_UUID;
    client.get(queryString, function (err, req, res, body) {
        t.equal(res.statusCode, 409);
        t.deepEqual(body, {
            code: 'ValidationFailed',
            message: 'Invalid Parameters',
            errors: [ {
                fields: ['offset', 'marker'],
                code: 'ConflictingParameters',
                message: 'offset and marker cannot be used at the same time'
            } ]
        });
        t.done();
    });
};

var fakeVmsUuid;

/*
 * This function creates a large number of "test" VMs
 * (VMs with alias='test--'), and then sends GET requests to /vms to retrieve
 * them by chunks. It uses the "marker" querystring param to paginate through
 * the results.
 * It then makes sure that after going through all test VMs, a subsequent
 * request returns an empty set.
 * Finally, it checks that there's no overlap between the different chunks
 * received.
 */
function testMarkerPagination(options, t, callback) {
    options = options || {};
    assert.object(options, 'options');

    assert.object(t, 't');
    assert.func(callback, 'callback');

    var NB_TEST_VMS_TO_CREATE = options.nbTestVms || 200;
    var LIMIT = NB_TEST_VMS_TO_CREATE / 2;

    var moray = new MORAY(common.config.moray);
    moray.connect();

    moray.once('moray-ready', function () {
        var firstVmsChunk;
        var secondVmsChunk;
        async.waterfall([
            // Delete test VMs leftover from previous tests run
            function deleteTestVms(next) {
                vmCommon.deleteTestVMs(moray, {}, function vmsDeleted(err) {
                    t.ifError(err, 'deleting test VMs should not error');
                    return next(err);
                });
            },
            function createFakeVms(next) {
                vmCommon.createTestVMs(NB_TEST_VMS_TO_CREATE, moray,
                    {concurrency: 100},
                    function fakeVmsCreated(err, vmsUuid) {
                        moray.connection.close();

                        fakeVmsUuid = vmsUuid;
                        t.equal(fakeVmsUuid.length,
                            NB_TEST_VMS_TO_CREATE,
                            NB_TEST_VMS_TO_CREATE
                            + ' vms should have been created');

                        t.ifError(err, NB_TEST_VMS_TO_CREATE
                            + ' vms should be created successfully');
                        return next(err);
                    });
            },
            function listFirstVmsChunk(next) {
                var listVmsQuery = '/vms?limit=' + LIMIT + '&alias='
                + vmCommon.TEST_VMS_ALIAS;
                if (options.sort)
                    listVmsQuery += '&sort=' + options.sort;

                client.get(listVmsQuery, function (err, req, res, body) {
                    t.ifError(err);
                    if (err)
                        return next(err);

                    t.equal(body.length, LIMIT,
                        LIMIT + ' vms should be returned from first list vms');

                    var marker = body[body.length - 1].uuid;
                    t.ok(typeof (marker) === 'string',
                        'last vm uuid should be a string');

                    firstVmsChunk = body;
                    return next(null, marker);
                });
            },
            function listNextVmsChunk(marker, next) {
                assert.string(marker, 'marker');
                var listVmsQuery = '/vms?limit=' + LIMIT + '&alias='
                + vmCommon.TEST_VMS_ALIAS + '&marker=' + marker;

                if (options.sort)
                    listVmsQuery += '&sort=' + options.sort;

                client.get(listVmsQuery, function (err, req, res, body) {
                        t.ifError(err);
                        if (err)
                            return next(err);

                        t.equal(body.length, LIMIT,
                            'second vms list request should return ' + LIMIT
                            + 'vms');
                        var nextMarker = body[body.length - 1].uuid;
                        t.ok(typeof (nextMarker) === 'string',
                            'last vm uuid should be a string');

                        secondVmsChunk = body;

                        return next(null, nextMarker);
                    });
            },
            function listLastVmsChunk(marker, next) {
                assert.string(marker, 'marker');

                var listVmsQuery = '/vms?limit=' + LIMIT + '&alias='
                + vmCommon.TEST_VMS_ALIAS + '&marker=' + marker;

                if (options.sort)
                    listVmsQuery += '&sort=' + options.sort;

                client.get(listVmsQuery, function (err, req, res, body) {
                        t.ifError(err);
                        if (err)
                            return next(err);

                        t.equal(body.length, 0,
                            'last vms list request should return no vm');
                        return next();
                    });
            },
            function checkNoOverlap(next) {
                var chunksOverlap = firstVmsChunk.some(function (vmUuid) {
                    return secondVmsChunk.indexOf(vmUuid) !== -1;
                });
                t.equal(chunksOverlap, false,
                    'subsequent responses should not overlap');
                return next();
            }
        ], function allDone(err, results) {
            t.ifError(err);
            return callback();
        });
    });
}

exports.list_vms_marker_ok = function (t) {
    testMarkerPagination({}, t, function testDone() {
        t.done();
    });
};

/*
 * Cleanup test VMs created by the previous test (list_vms_marker_ok).
 */
exports.delete_test_vms = function (t) {
    var moray = new MORAY(common.config.moray);
    moray.connect();

    moray.once('moray-ready', function () {
        vmCommon.deleteTestVMs(moray, {}, function testVmsDeleted(err) {
            moray.connection.close();
            t.ifError(err, 'deleting fake VMs should not error');
            t.done();
        });
    });
};

exports.list_vms_marker_sort_desc_ok = function (t) {
    testMarkerPagination({sort: 'uuid.desc'}, t, function testDone() {
        t.done();
    });
};

/*
 * Cleanup test VMs created by the previous test
 * (list_vms_marker_sort_desc_ok).
 */
exports.delete_test_vms_sort_desc_ok = function (t) {
    var moray = new MORAY(common.config.moray);
    moray.connect();

    moray.once('moray-ready', function () {
        vmCommon.deleteTestVMs(moray, {}, function testVmsDeleted(err) {
            moray.connection.close();
            t.ifError(err, 'deleting fake VMs should not error');
            t.done();
        });
    });
};

/*
 * Makes sure that sending the value "paramValue" as parameter "paramName" to
 * the vms listing endpoint results in a request error.
 */
function testInvalidParam(paramName, paramValue, expectedError, t, callback) {
    var queryString = '?' + paramName + '=' + encodeURIComponent(paramValue);
    var query = VMS_LIST_ENDPOINT + queryString;

    client.get(query, function (err, req, res, body) {
        t.equal(res.statusCode, 409,
        'sending ' + paramValue + ' for param ' + paramName
        + ' should result in an error status code');
        t.deepEqual(body, expectedError,
        'sending ' + paramValue + ' for param ' + paramName
        + ' should result in the proper error message being sent');
        return callback();
    });
}

/*
 * Makes sure that sending the value "paramValue" as parameter "paramName" to
 * the vms listing endpoint does not result in a request error.
 */

function testValidParam(paramName, paramValue, t, callback) {
    var queryString = '?' + paramName + '=' + encodeURIComponent(paramValue);
    var query = VMS_LIST_ENDPOINT + queryString;

    client.get(query, function (err, req, res, body) {
        t.equal(res.statusCode, 200,
        'sending ' + paramValue + ' for param ' + paramName
        + ' should not result in an error status code');
        return callback();
    });
}

exports.list_invalid_param = function (t) {
    var expectedError = {
        code: 'ValidationFailed',
        message: 'Invalid Parameters',
        errors: [ {
            field: 'foo',
            code: 'Invalid',
            message: 'Invalid parameter'
        } ]
    };
    testInvalidParam('foo', 'bar', expectedError, t, function done() {
        t.done();
    });
};

var UUID_PARAMS = ['uuid', 'owner_uuid', 'server_uuid', 'image_uuid'];

exports.list_param_invalid_uuids = function (t) {
    async.each(UUID_PARAMS,
    function (paramName, next) {
        var expectedError = {
            code: 'ValidationFailed',
            message: 'Invalid Parameters',
            errors: [ {
                field: paramName,
                code: 'Invalid',
                message: 'Invalid UUID'
            } ]
        };
        testInvalidParam(paramName, INVALID_UUID, expectedError, t, next);
    },
    function done(err) {
        t.done();
    });
};

exports.list_param_valid_uuid = function (t) {
    async.each(UUID_PARAMS,
    function (paramName, next) {
        testValidParam(paramName, VALID_UUID, t, next);
    },
    function (err) {
        t.done();
    });
};

var VALID_VM_BRANDS = [
    'joyent-minimal',
    'joyent',
    'lx',
    'kvm',
    'sngl'
];

exports.list_param_valid_brands = function (t) {
    async.each(VALID_VM_BRANDS, function (vmBrand, next) {
        testValidParam('brand', vmBrand, t, next);
    },
    function allDone(err) {
        t.done();
    });
};

exports.list_param_invalid_brand = function (t) {
    var expectedError = {
        code: 'ValidationFailed',
        message: 'Invalid Parameters',
        errors: [ {
            field: 'brand',
            code: 'Invalid',
            message: 'Must be one of: ' + VALID_VM_BRANDS.join(', ')
        } ]
    };

    testInvalidParam('brand', 'foobar', expectedError, t, function () {
        t.done();
    });
};

exports.list_param_valid_docker = function (t) {
    async.each(['true', 'false'], function (dockerFlag, next) {
        testValidParam('docker', dockerFlag, t, next);
    },
    function allDone(err) {
        t.done();
    });
};

exports.list_param_invalid_docker = function (t) {
    var expectedError = {
        code: 'ValidationFailed',
        message: 'Invalid Parameters',
        errors: [ {
            field: 'docker',
            code: 'Invalid',
            message: 'Invalid parameter'
        } ]
    };
    testInvalidParam('docker', 'foobar', expectedError, t, function () {
        t.done();
    });
};

exports.list_param_valid_alias = function (t) {
    testValidParam('alias', 'foo', t, function () {
        t.done();
    });
};

exports.list_param_invalid_alias = function (t) {
    var INVALID_ALIASES = ['', ','];
    async.each(INVALID_ALIASES,
    function (invalidAlias, next) {
        var expectedError = {
            code: 'ValidationFailed',
            message: 'Invalid Parameters',
            errors: [ {
                field: 'alias',
                code: 'Invalid',
                message: 'String does not match regexp: '
                + '/^[a-zA-Z0-9][a-zA-Z0-9\\_\\.\\-]*$/'
            } ]
        };
        testInvalidParam('alias', invalidAlias, expectedError, t, next);
    },
    function done(err) {
        t.done();
    });
};

var VALID_VM_STATES = [
    'running',
    'stopped',
    'active',
    'destroyed'
];

exports.list_param_valid_state = function (t) {
    async.each(VALID_VM_STATES, function (vmState, next) {
        testValidParam('state', vmState, t, next);
    },
    function allDone(err) {
        t.done();
    });
};

exports.list_param_invalid_state = function (t) {
    var expectedError = {
        code: 'ValidationFailed',
        message: 'Invalid Parameters',
        errors: [ {
            field: 'state',
            code: 'Invalid',
            message: 'Must be one of: ' + VALID_VM_STATES.join(', ')
        } ]
    };
    testInvalidParam('state', 'foobar', expectedError, t, function () {
        t.done();
    });
};

exports.list_param_valid_ram = function (t) {
    async.each(['1', '128', '2048'], function (ram, next) {
        testValidParam('ram', ram, t, next);
    },
    function allDone(err) {
        t.done();
    });
};

exports.list_param_invalid_ram = function (t) {
    async.each(['abc', '128,5', '128.5'],
    function (invalidRam, next) {
        var expectedError = {
            code: 'ValidationFailed',
            message: 'Invalid Parameters',
            errors: [ {
                field: 'ram',
                code: 'Invalid',
                message: 'String does not match regexp: /^0$|^([1-9][0-9]*$)/'
            } ]
        };
        testInvalidParam('ram', invalidRam, expectedError, t, next);
    },
    function done(err) {
        t.done();
    });
};

exports.list_param_valid_uuids = function (t) {
    async.each([
        [VALID_UUID].join(','),
        [VALID_UUID, VALID_UUID].join(',')
    ], function (uuids, next) {
        testValidParam('uuids', uuids, t, next);
    },
    function allDone(err) {
        t.done();
    });
};

exports.list_param_invalid_uuids = function (t) {
    async.each([
        '',
        [INVALID_UUID].join(','),
        [VALID_UUID, INVALID_UUID].join(',')
    ], function (invalidUuids, next) {
        var expectedError = {
            code: 'ValidationFailed',
            message: 'Invalid Parameters',
            errors: [ {
                field: 'uuids',
                code: 'Invalid',
                message: 'Invalid values: ' + invalidUuids
            } ]
        };
        testInvalidParam('uuids', invalidUuids, expectedError, t, next);
    },
    function allDone(err) {
        t.done();
    });
};

exports.list_param_valid_create_timestamp = function (t) {
    async.each([
        new Date().getTime(),
        new Date().toISOString()
    ], function (validTimestamp, next) {
        testValidParam('create_timestamp', validTimestamp, t, next);
    }, function allDone(err) {
        t.done();
    });
};

exports.list_param_invalid_create_timestamp = function (t) {
    async.each([
        'foo',
        new Date().getTime() + 'foo',
        new Date().toISOString() + 'foo'
    ], function (invalidTimestamp, next) {
        var expectedError = {
            code: 'ValidationFailed',
            message: 'Invalid Parameters',
            errors: [ {
                field: 'create_timestamp',
                code: 'Invalid',
                message: 'Invalid timestamp: ' + invalidTimestamp
            } ]
        };
        testInvalidParam('create_timestamp', invalidTimestamp, expectedError,
            t, next);
    }, function allDone(err) {
        t.done();
    });
};

exports.list_param_valid_vm_fields = function (t) {
    var allVmFields = validation.VM_FIELDS.map(function (vmField) {
        return vmField.name;
    });

    var validVmFieldsList = allVmFields.concat([
        allVmFields.join(','),
        'role_tags',
        '*'
    ]);

    async.each(validVmFieldsList,
        function (validVmFields, next) {
            testValidParam('fields', validVmFields, t, next);
        },
        function allDone(err) {
            t.done();
        });
};

exports.list_param_invalid_vm_fields = function (t) {
    async.each([
        'foo',
        '',
        'foo,bar',
        validation.VM_FIELDS[0].name + ',bar'
    ], function (invalidVmFields, next) {
        var expectedError = {
            code: 'ValidationFailed',
            message: 'Invalid Parameters',
            errors: [ {
                field: 'fields',
                code: 'Invalid',
                message: 'Invalid values: ' + invalidVmFields
            } ]
        };
        testInvalidParam('fields', invalidVmFields, expectedError, t, next);
    }, function allDone(err) {
        t.done();
    });
};
