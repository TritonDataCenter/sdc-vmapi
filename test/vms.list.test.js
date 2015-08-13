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

var MAX_LIMIT = 1000;

exports.setUp = function (callback) {
    common.setUp(function (err, _client) {
        assert.ifError(err);
        assert.ok(_client, 'restify client');
        client = _client;
        callback();
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

exports.list_param_valid_limit = function (t) {
    async.each([1, 500, MAX_LIMIT, MAX_LIMIT * 2],
        function (validLimit, next) {
            testValidParam('limit', validLimit, t, next);
        },
        function allDone(err) {
            t.done();
        });
};

exports.list_param_invalid_limit = function (t) {
    async.each(['foo', -1], function (invalidLimit, next) {
        var expectedError = {
            code: 'ValidationFailed',
            message: 'Invalid Parameters',
            errors: [ {
                field: 'limit',
                code: 'Invalid',
                message: 'Not a valid number: number must be >= 0'
            } ]
        };
        testInvalidParam('limit', invalidLimit, expectedError,
            t, next);
    }, function allDone(err) {
        t.done();
    });
};

exports.list_param_valid_offset = function (t) {
    async.each([0, 1, 500], function (validOffset, next) {
        testValidParam('offset', validOffset, t, next);
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
        testInvalidParam('offset', invalidOffset, expectedError,
            t, next);
    }, function allDone(err) {
        t.done();
    });
};
