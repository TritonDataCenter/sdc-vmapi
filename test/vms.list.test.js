/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');
var async = require('async');
var Logger = require('bunyan');
var restify = require('restify');

var changefeedUtils = require('../lib/changefeed');
var common = require('./common');
var morayInit = require('../lib/moray/moray-init');
var validation = require('../lib/common/validation');
var vmTest = require('./lib/vm');

var client;
var moray;
var morayClient;

var VALID_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
var INVALID_UUID = 'invalid_uuid';

var MAX_LIMIT = 1000;

exports.setUp = function (callback) {
    common.setUp(function (err, _client) {
        assert.ifError(err);
        assert.ok(_client, 'restify client');
        client = _client;
        callback();
    });
};

exports.init_storage_layer = function (t) {
     var morayBucketsInitializer;

    var moraySetup = morayInit.startMorayInit({
        morayConfig: common.config.moray,
        maxBucketsReindexAttempts: 1,
        maxBucketsSetupAttempts: 1,
        changefeedPublisher: changefeedUtils.createNoopCfPublisher()
    });

    morayBucketsInitializer = moraySetup.morayBucketsInitializer;
    morayClient = moraySetup.morayClient;
    moray = moraySetup.moray;

    morayBucketsInitializer.on('done', function onMorayStorageReady() {
        t.done();
    });
};

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
    common.testListInvalidParams(client, {foo: 'bar'}, expectedError, t,
        function done() {
            t.done();
        });
};

var UUID_PARAMS = ['uuid', 'owner_uuid', 'server_uuid', 'image_uuid'];

exports.list_invalid_uuid_params = function (t) {
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

        var invalidParams = {};
        invalidParams[paramName] = INVALID_UUID;

        common.testListInvalidParams(client, invalidParams, expectedError, t,
            next);
    },
    function done(err) {
        t.done();
    });
};

exports.list_param_valid_uuid = function (t) {
    async.each(UUID_PARAMS,
    function (paramName, next) {
        var params = {};
        params[paramName] = VALID_UUID;

        common.testListValidParams(client, params, t, next);
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
        common.testListValidParams(client, {brand: vmBrand}, t, next);
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

    common.testListInvalidParams(client, {brand: 'foobar'}, expectedError, t,
        function testDone() {
            t.done();
        });
};

exports.list_param_valid_docker = function (t) {
    async.each(['true', 'false'], function (dockerFlag, next) {
        common.testListValidParams(client, {docker: dockerFlag}, t,
            function (err, body) {
                if (err) {
                    return next(err);
                }

                body.forEach(function (vm) {
                    if (dockerFlag === 'true') {
                        t.ok(vm.docker);
                    } else {
                        t.ok(vm.docker === undefined || vm.docker === false);
                    }
                });

                return next();
            });
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
    common.testListInvalidParams(client, {docker: 'foobar'}, expectedError, t,
        function testDone() {
            t.done();
        });
};

exports.list_param_valid_alias = function (t) {
    common.testListValidParams(client, {alias: 'foo'}, t, function () {
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
        common.testListInvalidParams(client, {alias: invalidAlias},
            expectedError, t, next);
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
        common.testListValidParams(client, {state: vmState}, t, next);
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
    common.testListInvalidParams(client, {state: 'foobar'}, expectedError, t,
        function testDone() {
            t.done();
        });
};

exports.list_param_valid_ram = function (t) {
    async.each(['1', '128', '2048'], function (ram, next) {
        common.testListValidParams(client, {ram: ram}, t, next);
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
        common.testListInvalidParams(client, {ram: invalidRam}, expectedError,
            t, next);
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
        common.testListValidParams(client, {uuids: uuids}, t, next);
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
        common.testListInvalidParams(client, {uuids: invalidUuids},
            expectedError, t, next);
    },
    function allDone(err) {
        t.done();
    });
};

/*
 * This function creates a large number of "test" VMs
 * (VMs with alias='test--'), and then sends GET requests to /vms to retrieve
 * them by passing a specific "limit" value.
 * It then makes sure that the correct number of VMs are included in the
 * results, that is the number of VMs created, unless it's greater than the
 * maximum value for "limit".
 */
function testValidLimit(limit, t, callback) {
    assert.finite(limit, 'options');

    assert.object(t, 't');
    assert.func(callback, 'callback');

    var NB_TEST_VMS_TO_CREATE = limit + 1;
    var EXPECTED_NB_VMS_RETURNED = Math.min(limit, MAX_LIMIT);

    // limit === 0 means "unlimited"
    if (limit === 0) {
        EXPECTED_NB_VMS_RETURNED = NB_TEST_VMS_TO_CREATE;
    }

    async.series([
        // Delete test VMs leftover from previous tests run
        function deleteTestVms(next) {
            vmTest.deleteTestVMs(moray, {},
                function vmsDeleted(err) {
                    t.ifError(err, 'deleting test VMs should not error');
                    return next(err);
                });
        },
        function createFakeVms(next) {
            vmTest.createTestVMs(NB_TEST_VMS_TO_CREATE, moray,
                {concurrency: 100}, {},
                function fakeVmsCreated(err, vmUuids) {
                    t.equal(vmUuids.length,
                        NB_TEST_VMS_TO_CREATE,
                        NB_TEST_VMS_TO_CREATE
                        + ' vms should have been created');

                    t.ifError(err, NB_TEST_VMS_TO_CREATE
                        + ' vms should be created successfully');
                    return next(err);
                });
        },
        function listVmsWithLimit(next) {
            var listVmsQuery = '/vms?limit=' + limit + '&alias='
            + vmTest.TEST_VMS_ALIAS;

            client.get(listVmsQuery, function (err, req, res, body) {
                t.ifError(err);
                if (err)
                    return next(err);

                t.equal(res.headers['x-joyent-resource-count'],
                    NB_TEST_VMS_TO_CREATE,
                    'x-joyent-resource-count header should be equal to '
                    + NB_TEST_VMS_TO_CREATE);
                t.equal(body.length, EXPECTED_NB_VMS_RETURNED,
                    EXPECTED_NB_VMS_RETURNED
                    + ' vms should be returned from list vms');

                return next(null);
            });
        }
    ], function allDone(err, results) {
        t.ifError(err);
        return callback();
    });
}

exports.list_vms_valid_limit = function (t) {
    async.eachSeries([1, MAX_LIMIT / 2, MAX_LIMIT],
        function (validLimit, next) {
            testValidLimit(validLimit, t, next);
        },
        function allDone(err) {
            t.done();
        });
};

/*
 * Cleanup test VMs created by the previous test
 * (list_vms_valid_limit).
 */
exports.delete_list_vms_valid_limit = function (t) {
    vmTest.deleteTestVMs(moray, {}, function testVmsDeleted(err) {
        t.ifError(err, 'deleting fake VMs should not error');
        t.done();
    });
};

exports.list_param_valid_create_timestamp = function (t) {
    async.each([
        new Date().getTime(),
        new Date().toISOString()
    ], function (validTimestamp, next) {
        common.testListValidParams(client, {create_timestamp: validTimestamp},
            t, next);
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
        common.testListInvalidParams(client,
            {create_timestamp: invalidTimestamp}, expectedError, t, next);
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
            common.testListValidParams(client, {fields: validVmFields}, t,
                next);
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
        common.testListInvalidParams(client, {fields: invalidVmFields},
            expectedError, t, next);
    }, function allDone(err) {
        t.done();
    });
};

exports.list_param_valid_limit = function (t) {
    async.each([1, 500, MAX_LIMIT],
        function (validLimit, next) {
            common.testListValidParams(client, {limit: validLimit}, t, next);
        },
        function allDone(err) {
            t.done();
        });
};

exports.list_param_invalid_limit = function (t) {
    async.each(['foo', -1, 0, MAX_LIMIT + 1], function (invalidLimit, next) {
        var expectedError = {
            code: 'ValidationFailed',
            message: 'Invalid Parameters',
            errors: [ {
                field: 'limit',
                code: 'Invalid',
                message: 'Not a valid number: number must be >= 1 and <= ' +
                    MAX_LIMIT
            } ]
        };
        common.testListInvalidParams(client, {limit: invalidLimit},
            expectedError, t, next);
    }, function allDone(err) {
        t.done();
    });
};

exports.list_param_valid_offset = function (t) {
    async.each([0, 1, 500], function (validOffset, next) {
        common.testListValidParams(client, {offset: validOffset}, t, next);
    }, function allDone(err) {
        t.done();
    });
};

exports.list_param_invalid_offset = function (t) {
    async.each(['foo', -1], function (invalidOffset, next) {
        var expectedError = {
            code: 'ValidationFailed',
            message: 'Invalid Parameters',
            errors: [ {
                field: 'offset',
                code: 'Invalid',
                message: 'Not a valid number: number must be >= 0'
            } ]
        };
        common.testListInvalidParams(client, {offset: invalidOffset},
            expectedError, t, next);
    }, function allDone(err) {
        t.done();
    });
};

exports.close_moray_client = function (t) {
    morayClient.close();
    t.done();
};