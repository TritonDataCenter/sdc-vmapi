/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var url = require('url');

var assert = require('assert-plus');
var async = require('async');
var libuuid = require('libuuid');

var common = require('./common');
var vmTest = require('./lib/vm');

var MORAY = require('../lib/apis/moray');
var sortValidation = require('../lib/validation/sort.js');
var vmCommon = require('../lib/common/vm-common.js');

var client;

exports.setUp = function (callback) {
    common.setUp(function (err, _client) {
        assert.ifError(err);
        assert.ok(_client, 'restify client');
        client = _client;
        callback();
    });
};

/*
 * Creates a marker object that can be used to paginate through ListVms's
 * results. It returns an object that has the properties listed in the
 * "markerKeys" array and the values for these keys are copied from the
 * "vmObject" object.
 */
function buildMarker(vmObject, markerKeys) {
    assert.object(vmObject, 'vmObject must be an object');
    assert.arrayOfString(markerKeys, 'markerKeys must be an array of strings');

    var marker = {};

    markerKeys.forEach(function (markerKey) {
        if (markerKey === 'tags')
            marker[markerKey] = vmCommon.objectToTagFormat(vmObject[markerKey]);
        else
            marker[markerKey] = vmObject[markerKey];
    });

    return marker;
}

/*
 * This function creates a large number of "test" VMs
 * (VMs with alias='test--', unless otherwise specified), and then sends GET
 * requests to /vms to retrieve them by chunks. It uses the "marker"
 * querystring param to paginate through the results. It then makes sure that
 * after going through all test VMs, a subsequent request returns an empty set.
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

    var vmsCreationParams = options.vmsCreationParams || {};
    assert.object(vmsCreationParams,
        'options.vmsCreationParams must be an object');

    assert.ok(typeof (options.sort === 'string') || options.sort === undefined,
        'options.sort must be undefined or a string');

    var queryStringObject = {
        limit: LIMIT
    };

    if (vmsCreationParams.alias !== undefined)
        queryStringObject.alias = vmTest.TEST_VMS_ALIAS +
            vmsCreationParams.alias;
    else
        queryStringObject.alias = vmTest.TEST_VMS_ALIAS;

    if (options.sort !== undefined)
        queryStringObject.sort = options.sort;

    var markerKeys = options.markerKeys || [];
    assert.arrayOfString(markerKeys,
        'options.markerKeys must be an array of strings');

    moray.once('moray-ready', function () {
        var firstVmsChunk;
        var secondVmsChunk;
        async.waterfall([
            // Delete test VMs leftover from previous tests run
            function deleteTestVms(next) {
                vmTest.deleteTestVMs(moray, {}, function vmsDeleted(err) {
                    t.ifError(err, 'deleting test VMs should not error');
                    return next(err);
                });
            },
            function createFakeVms(next) {
                vmTest.createTestVMs(NB_TEST_VMS_TO_CREATE, moray,
                    {concurrency: 100}, vmsCreationParams,
                    function fakeVmsCreated(err, vmsUuid) {
                        moray.connection.close();

                        t.equal(vmsUuid.length,
                            NB_TEST_VMS_TO_CREATE,
                            NB_TEST_VMS_TO_CREATE
                            + ' vms should have been created');

                        t.ifError(err, NB_TEST_VMS_TO_CREATE
                            + ' vms should be created successfully');
                        return next(err);
                    });
            },
            function listFirstVmsChunk(next) {
                var listVmsQuery = url.format({pathname: '/vms',
                    query: queryStringObject});

                client.get(listVmsQuery, function (err, req, res, body) {
                    var lastItem;

                    t.ifError(err);
                    if (err)
                        return next(err);

                    t.equal(res.headers['x-joyent-resource-count'],
                        NB_TEST_VMS_TO_CREATE,
                        'x-joyent-resource-count header should be equal to '
                        + NB_TEST_VMS_TO_CREATE);
                    t.equal(body.length, LIMIT,
                        LIMIT + ' vms should be returned from first list vms');

                    lastItem = body[body.length - 1];
                    var marker = buildMarker(lastItem, markerKeys);

                    firstVmsChunk = body;
                    return next(null, JSON.stringify(marker));
                });
            },
            function listNextVmsChunk(marker, next) {
                assert.string(marker, 'marker');
                queryStringObject.marker = marker;

                var listVmsQuery = url.format({pathname: '/vms',
                    query: queryStringObject});

                client.get(listVmsQuery, function (err, req, res, body) {
                    var lastItem;

                    t.ifError(err);
                    if (err)
                        return next(err);

                    t.equal(res.headers['x-joyent-resource-count'],
                        NB_TEST_VMS_TO_CREATE,
                        'x-joyent-resource-count header should be equal to '
                        + NB_TEST_VMS_TO_CREATE);
                    t.equal(body.length, LIMIT,
                        'second vms list request should return ' + LIMIT
                        + ' vms');

                    lastItem = body[body.length - 1];
                    var nextMarker = buildMarker(lastItem, markerKeys);

                    secondVmsChunk = body;

                    return next(null, JSON.stringify(nextMarker));
                });
            },
            function listLastVmsChunk(marker, next) {
                assert.string(marker, 'marker must be a string');
                queryStringObject.marker = marker;

                var listVmsQuery = url.format({pathname: '/vms',
                    query: queryStringObject});

                client.get(listVmsQuery, function (err, req, res, body) {
                    t.ifError(err);
                    if (err)
                        return next(err);

                    t.equal(res.headers['x-joyent-resource-count'],
                        NB_TEST_VMS_TO_CREATE,
                        'x-joyent-resource-count header should be equal to '
                        + NB_TEST_VMS_TO_CREATE);
                    t.equal(body.length, 0,
                        'last vms list request should return no vm');
                    return next();
                });
            },
            function checkNoOverlap(next) {
                function getVmUuid(vm) {
                    assert.object(vm, 'vm must be an object');
                    return vm.uuid;
                }

                var firstVmsChunkUuids = firstVmsChunk.map(getVmUuid);
                var secondVmsChunkUuids = secondVmsChunk.map(getVmUuid);
                var chunksOverlap = firstVmsChunkUuids.some(function (vmUuid) {
                    return secondVmsChunkUuids.indexOf(vmUuid) !== -1;
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

/*
 * Checks that invalid markers result in the response containing
 * the proper error status code and error message.
 */
exports.list_vms_marker_not_valid_JSON_object_not_ok = function (t) {
    async.eachSeries([
     '["uuid: 00000000-0000-0000-0000-000000000000"]',
     '00000000-0000-0000-0000-000000000000',
     '""',
     ''
     ], function testBadMarker(badMarker, next) {
        var expectedError = {
            code: 'ValidationFailed',
            message: 'Invalid Parameters',
            errors: [ {
                field: 'marker',
                code: 'Invalid',
                message: 'Invalid marker: ' + JSON.stringify(badMarker) +
                '. Marker must represent an object.'
            }]
        };

        return common.testListInvalidParams(client,
            {marker: JSON.stringify(badMarker)}, expectedError, t, next);
     }, function allDone(err) {
        t.done();
     });
};

/*
 * Using offset and marker params in the same request is not valid.
 * Check that using them both in the same request results in the
 * response having the proper error code and message.
 */
exports.list_vms_offset_and_marker_not_ok = function (t) {
    var FAKE_VM_UUID = '00000000-0000-0000-0000-000000000000';
    var marker = {
        uuid: FAKE_VM_UUID
    };
    var queryString = '/vms?offset=1&marker=' + JSON.stringify(marker);
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

/*
 * Checks that using the only key that can establish a strict total order
 * as a marker to paginate through a test VMs set works as expected,
 * without any error.
 */
exports.list_vms_marker_ok = function (t) {
    testMarkerPagination({
        markerKeys: ['uuid']
    }, t, function testDone() {
        t.done();
    });
};

/*
 * Cleanup test VMs created by the previous test (list_vms_marker_ok).
 */
exports.delete_test_vms_marker_ok = function (t) {
    var moray = new MORAY(common.config.moray);
    moray.connect();

    moray.once('moray-ready', function () {
        vmTest.deleteTestVMs(moray, {}, function testVmsDeleted(err) {
            moray.connection.close();
            t.ifError(err, 'deleting fake VMs should not error');
            t.done();
        });
    });
};

/*
 * Same test as list_vms_marker_ok, but adding a sort param on uuid ascending.
 * Check that it works successfully as expected.
 */
exports.list_vms_marker_and_sort_on_uuid_asc_ok = function (t) {
    testMarkerPagination({
        sort: 'uuid.ASC',
        markerKeys: ['uuid']
    }, t, function testDone() {
        t.done();
    });
};

/*
 * Cleanup test VMs created by the previous test
 * (list_vms_marker_and_sort_on_uuid_asc_ok).
 */
exports.delete_test_vms_marker_and_sort_on_uuid_asc_ok = function (t) {
    var moray = new MORAY(common.config.moray);
    moray.connect();

    moray.once('moray-ready', function () {
        vmTest.deleteTestVMs(moray, {}, function testVmsDeleted(err) {
            moray.connection.close();
            t.ifError(err, 'deleting fake VMs should not error');
            t.done();
        });
    });
};

/*
 * Same test as list_vms_marker_ok, but adding a sort param on uuid descending.
 * Check that it works successfully as expected.
 */
exports.list_vms_marker_and_sort_on_uuid_desc_ok = function (t) {
    testMarkerPagination({
        sort: 'uuid.DESC',
        markerKeys: ['uuid']
    }, t, function testDone() {
        t.done();
    });
};

/*
 * Cleanup test VMs created by the previous test
 * (list_vms_marker_and_sort_on_uuid_desc_ok).
 */
exports.delete_test_vms_marker_and_sort_on_uuid_desc_ok = function (t) {
    var moray = new MORAY(common.config.moray);
    moray.connect();

    moray.once('moray-ready', function () {
        vmTest.deleteTestVMs(moray, {}, function testVmsDeleted(err) {
            moray.connection.close();
            t.ifError(err, 'deleting fake VMs should not error');
            t.done();
        });
    });
};

exports.marker_key_not_in_sort_field_not_ok = function (t) {
    var TEST_MARKER = {create_timestamp: Date.now(), uuid: libuuid.create()};
    var expectedError = {
        code: 'ValidationFailed',
        message: 'Invalid Parameters',
        errors: [ {
            field: 'marker',
            code: 'Invalid',
            message: 'Invalid marker: ' + JSON.stringify(TEST_MARKER) +
            '. All marker keys except uuid must be present in the sort ' +
            'parameter. Sort fields: undefined.'
        } ]
    };

    common.testListInvalidParams(client,
        {marker: JSON.stringify(TEST_MARKER)}, expectedError, t,
        function testDone(err) {
            t.done();
        });
};

/*
 * Most sort parameters do not allow to establish a strict total order relation
 * between all VMs. For instance, sorting on "create_timestamp" and paginating
 * through results by using the create_timestamp property as a marker,
 * it is possible that two VM objects have the same create_timestamp. When
 * sending the create_timestamp value of the latest VM item from the first page
 * of results as a marker to get the second page of results, the server cannot
 * tell which one of the two VMs the marker represents, and thus results can
 * be unexpected.
 *
 * In order to be able to "break the tie", an attribute of VMs that allows
 * to establish a strict total order has to be specified in the marker.
 * Currently, the only attribute that has this property is "uuid".
 *
 * For each VM attribute on which users can sort that do not provide a strict
 * total order, the tests below a series of tests that uses each sort criteria
 * and a variety of marker configurations to make sure that the implementation
 * behaves as expected.
 */

/*
 * This table associates each sort key that doesn't provide a strict
 * total order with a constant value. These constant values are used
 * for all VMs of a test data set, so that using only these keys in
 * a marker to identify the first item of the next page of results is
 * not sufficient.
 */
var NON_STRICT_TOTAL_ORDER_SORT_KEYS = {
    owner_uuid: libuuid.create(),
    image_uuid: libuuid.create(),
    billing_id: libuuid.create(),
    server_uuid: libuuid.create(),
    package_name: 'package_name_foo',
    package_version: 'package_version_foo',
    tags: vmCommon.objectToTagFormat({sometag: 'foo'}),
    brand: 'foobrand',
    state: 'test',
    alias: 'test--marker-pagination',
    max_physical_memory: 42,
    create_timestamp: Date.now(),
    docker: true
};

/*
 * Given a sort key, creates a set of tests that check a few expected
 * behaviors with that key.
 */
function createMarkerTests(sortKey, exports) {
    assert.string(sortKey, 'sortKey must be a string');
    assert.object(exports, 'exports must be an object');

    sortValidation.VALID_SORT_ORDERS.forEach(function (sortOrder) {
        createValidMarkerTest(sortKey, sortOrder, exports);
        createDeleteVMsTest(sortKey, sortOrder, exports);
        createSortKeyNotInMarkerTest(sortKey, sortOrder, exports);
        createNoStrictTotalOrderKeyInMarkerTest(sortKey, sortOrder, exports);
    });
}

/*
 * Given a sort key and a sort order, it creates a fake data set with the same
 * value for the property "sortKey". Then, it paginates through this data set
 * by using a marker composed of the sort key and "uuid" (which establishes a
 * strict total order) and checks that it can paginate through the all results
 * set without any error and duplicate entries.
 */
function createValidMarkerTest(sortKey, sortOrder, exports) {
    var newTestName = 'list_vms_marker_with_identical_' + sortKey + '_' +
        sortOrder + '_ok';
    var vmsCreationParams = {};
    vmsCreationParams[sortKey] =
        NON_STRICT_TOTAL_ORDER_SORT_KEYS[sortKey];

    exports[newTestName] = function (t) {
        testMarkerPagination({
            sort: sortKey + '.' + sortOrder,
            markerKeys: [sortKey, 'uuid'],
            vmsCreationParams: vmsCreationParams
        }, t, function testDone() {
            t.done();
        });
    };
}

/*
 * Creates a test that deletes the fake VMs created by the tests created
 * by createValidMarkerTest.
 */
function createDeleteVMsTest(sortKey, sortOrder, exports) {
    var clearVmsTestName = 'delete_test_vms_marker_with_identical_' + sortKey +
            '_' + sortOrder + '_ok';
    exports[clearVmsTestName] = function (t) {
        var moray = new MORAY(common.config.moray);
        moray.connect();

        moray.once('moray-ready', function () {
            vmTest.deleteTestVMs(moray, {}, function testVmsDeleted(err) {
                moray.connection.close();
                t.ifError(err, 'deleting fake VMs should not error');
                t.done();
            });
        });
    };
}

/*
 * Creates a test that makes sure that when using sort to list VMs and a
 * marker, not adding the sort key to the marker results in the proper error
 * being sent.
 */
function createSortKeyNotInMarkerTest(sortKey, sortOrder, exports) {
    var testName = 'list_vms_marker_sortkey_' + sortKey + '_' + sortOrder +
        '_not_in_marker_not_ok';
    var TEST_MARKER = {uuid: 'some-uuid'};
    var TEST_SORT_PARAM = sortKey + '.' + sortOrder;

    var expectedError = {
        code: 'ValidationFailed',
        message: 'Invalid Parameters',
        errors: [ {
            field: 'marker',
            code: 'Invalid',
            message: 'Invalid marker: ' + JSON.stringify(TEST_MARKER) +
            '. All sort fields must be present in marker. Sort fields: ' +
            TEST_SORT_PARAM + '.'
        } ]
    };

    exports[testName] = function (t) {
        common.testListInvalidParams(client,
            {marker: JSON.stringify(TEST_MARKER), sort: TEST_SORT_PARAM},
            expectedError, t,
            function testDone(err) {
                t.done();
            });
    };
}

/*
 * Creates a test that makes sure that when using a marker without a property
 * that can establish a strict total order over a set of VMs, the proper error
 * is sent.
 */
function createNoStrictTotalOrderKeyInMarkerTest(sortKey, sortOrder, exports) {
    var testName = 'list_vms_marker_' + sortKey + '_' + sortOrder +
        '_no_strict_total_order_key';

    exports[testName] = function (t) {
        var TEST_MARKER = {};
        TEST_MARKER[sortKey] = NON_STRICT_TOTAL_ORDER_SORT_KEYS[sortKey];

        var expectedError = {
            code: 'ValidationFailed',
            message: 'Invalid Parameters',
            errors: [ {
                field: 'marker',
                code: 'Invalid',
                message: 'Invalid marker: ' + JSON.stringify(TEST_MARKER) +
                '. A marker needs to have a uuid property from ' +
                'which a strict total order can be established'
            } ]
        };

        common.testListInvalidParams(client,
            {marker: JSON.stringify(TEST_MARKER), sort: sortKey},
            expectedError, t,
            function testDone(err) {
                t.done();
            });
    };
}

Object.keys(NON_STRICT_TOTAL_ORDER_SORT_KEYS).forEach(function (sortKey) {
    createMarkerTests(sortKey, exports);
});
