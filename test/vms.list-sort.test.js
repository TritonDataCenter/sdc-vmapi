/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var assert = require('assert-plus');
var vasync = require('vasync');

var sortValidation = require('../lib/validation/sort');

var testCommon = require('./common');

var CLIENT;

exports.setUp = function (callback) {
    testCommon.setUp(function (err, _client) {
        assert.ifError(err);
        assert.ok(_client, 'restify client');
        CLIENT = _client;
        callback();
    });
};

exports.list_param_invalid_sort = function (t) {
    var INVALID_SORT_PARAMS = [
        'foo',
        'foo.DESC',
        'foo.desc',
        'foo.ASC',
        'foo.asc',
        'create_timestamp.foo',
        'create_timestamp.'
    ];

    vasync.forEachParallel({
        func: function listWithInvalidSort(invalidSortParam, callback) {
            var expectedError = {
                code: 'ValidationFailed',
                message: 'Invalid Parameters',
                errors: [ {
                    field: 'sort',
                    code: 'Invalid',
                    message: 'Invalid sort param: ' + invalidSortParam
                } ]
            };

            testCommon.testListInvalidParams(CLIENT, {sort: invalidSortParam},
               expectedError, t, callback);
        },
        inputs: INVALID_SORT_PARAMS
    }, function allTestsDone(err) {
        t.done();
    });
};

exports.list_param_valid_sort = function (t) {
    var VALID_SORT_PARAMS = [];
    var VALID_SORT_ORDERS = ['ASC', 'asc', 'DESC', 'desc'];

    sortValidation.VALID_SORT_KEYS.forEach(function (validSortKey) {
        VALID_SORT_ORDERS.forEach(function (validSortOrder) {
            VALID_SORT_PARAMS.push(validSortKey + '.' + validSortOrder);
        });
    });

    vasync.forEachParallel({
        func: function listWithValidSort(validSortParam, callback) {
            testCommon.testListValidParams(CLIENT, {sort: validSortParam}, t,
                function (err, body) {
                    t.ifError(err,
                        'Listing VMs with a valid sorting param should not ' +
                        'result in an error');
                    t.ok(Array.isArray(body),
                        'The response should be an array of VMs');
                    t.ok(body.length > 1,
                        'The response should contain more than one VM');

                    return callback();
                });
        },
        inputs: VALID_SORT_PARAMS
    }, function allTestsDone(err) {
        t.done();
    });
};
