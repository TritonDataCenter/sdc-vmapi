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
var bunyan = require('bunyan');
var Logger = require('bunyan');
var restify = require('restify');
var util = require('util');
var vasync = require('vasync');

var changefeedUtils = require('../lib/changefeed');
var common = require('./common');
var morayInit = require('../lib/moray/moray-init');
var validation = require('../lib/common/validation');
var vmTest = require('./lib/vm');

var client;
var moray;
var morayClient;

var testLogger = bunyan.createLogger({
    name: 'test-internal-metadata',
    level: 'debug',
    serializers: restify.bunyan.serializers
});

function runValidationErrorTestCase(t, testCase, callback) {
    assert.object(t, 't');
    assert.object(testCase, 'testCase');
    assert.string(testCase.queryString, 'testCase.queryString');
    assert.object(testCase.expectedErr, 'testCase.expectedErr');
    assert.func(callback, 'callback');

    var listVmsQuery = '/vms?' + testCase.queryString;

    client.get(listVmsQuery, function onListVms(err, req, res, body) {
        t.ok(err, 'listing VMs should error');
        if (err) {
            t.deepEqual(body, testCase.expectedErr,
                'Error should be equal to ' +
                    util.inspect(testCase.expectedErr) + ', got: ' +
                    util.inspect(err));
        }

        callback();
    });
}

function runValidTestCase(t, testCase, callback) {
    assert.object(t, 't');
    assert.object(testCase, 'testCase');
    assert.arrayOfString(testCase.queryStrings, 'testCase.queryStrings');
    assert.arrayOfObject(testCase.vmsToCreate, 'testCase.vmsToCreate');
    assert.func(callback, 'callback');

    var createdVmUuids = [];
    var vmsToCreate = testCase.vmsToCreate;

    vasync.pipeline({funcs: [
        function createTestVms(_, next) {
            vasync.forEachPipeline({
                func: function createTestVm(vmParams, done) {
                    vmTest.createTestVm(moray, {log: testLogger}, vmParams,
                        function onVmCreated(vmCreatErr, vmUuid) {
                            createdVmUuids.push(vmUuid);
                            done(vmCreatErr);
                        });
                },
                inputs: vmsToCreate
            }, next);
        },
        function listVms(_, next) {
            vasync.forEachPipeline({
                func: doList,
                inputs: testCase.queryStrings
            }, next);
        },
        function deleteTestVms(_, next) {
            vmTest.deleteTestVMs(moray, {}, next);
        }
    ]}, function onDone(err) {
        t.ifError(err);
        callback();
    });

    function doList(queryString, done) {
        assert.string(queryString, 'queryString');
        assert.func(done, 'done');

        var idx;
        var query = '/vms?' + queryString;
        var vm;

        client.get(query, function onList(err, req, res, body) {
            t.ok(!err, 'listing VM with query string "' + query +
                '"should not error');
            t.ok(body, 'response should not be empty');
            if (body) {
                t.equal(body.length, vmsToCreate.length,
                    'response should include ' + vmsToCreate.length + ' VMs, ' +
                        'got: ' + body.length);

                for (idx = 0; idx < body.length; ++idx) {
                    vm = body[idx];
                    t.notEqual(createdVmUuids.indexOf(vm.uuid), -1,
                        'returned VM UUID (' + vm.uuid + ') should be ' +
                            'included in created VMs ' + 'UUIDs (' +
                            createdVmUuids.join(', ') + ')');
                }
            }

            done();
        });
    }
}

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

exports.cleanup_leftover_test_vms = function (t) {
    vmTest.deleteTestVMs(moray, {}, function onTestVmsDeleted(delTestVmsErr) {
        t.ifError(delTestVmsErr, 'Deleting test VMs should not error');
        t.done();
    });
};

exports.run_validation_error_tests = function (t) {
    var testCases = [
        {
            queryString: 'internal_metadata.=foo',
            expectedErr: {
                code: 'ValidationFailed',
                message: 'Invalid Parameters',
                errors: [ {
                    field: 'internal_metadata',
                    code: 'Invalid',
                    message: 'Invalid internal_metadata key: ""'
                } ]
            }
        },
        {
            queryString: 'internal_metadata.foo=',
            expectedErr: {
                code: 'ValidationFailed',
                message: 'Invalid Parameters',
                errors: [ {
                    field: 'internal_metadata',
                    code: 'Invalid',
                    message: 'Invalid internal_metadata value: ""'
                } ]
            }
        }
    ];

    vasync.forEachPipeline({
        func: runValidationErrorTestCase.bind(null, t),
        inputs: testCases
    }, function onAllValidationErrorTestCasesRan(err) {
        t.done();
    });
};

exports.run_valid_test_cases = function (t) {
    var testCases = [
        /*
         * Simple key/value format.
         */
        {
            vmsToCreate: [ {internal_metadata: {'key': 'foo'}} ],
            queryStrings: [
                'internal_metadata.key=foo',
                'predicate=' + JSON.stringify({
                    eq: ['internal_metadata.key', 'foo']
                }),
                'query=(internal_metadata_search_array=key=foo)'
            ]
        },
        /*
         * Dotted key.
         */
        {
            vmsToCreate: [ {internal_metadata: {'some.key': 'foo'}} ],
            queryStrings: [
                'internal_metadata.some.key=foo',
                'predicate=' + JSON.stringify({
                    eq: ['internal_metadata.some.key', 'foo']
                }),
                'query=(internal_metadata_search_array=some.key=foo)'
            ]
        },
        /*
         * Namespaced key.
         */
        {
            vmsToCreate: [ {internal_metadata: {'some:key': 'foo'}} ],
            queryStrings: [
                'internal_metadata.some:key=foo',
                'predicate=' + JSON.stringify({
                    eq: ['internal_metadata.some:key', 'foo']
                }),
                'query=(internal_metadata_search_array=some:key=foo)'
            ]
        },
        /*
         * Key with equal ("=") character in it.
         */
        {
            vmsToCreate: [ {internal_metadata: {'some=key': 'foo'}} ],
            queryStrings: [
                'internal_metadata.some%3Dkey=foo',
                'predicate=' + JSON.stringify({
                    eq: ['internal_metadata.some=key', 'foo']
                }),
                'query=(internal_metadata_search_array=some=key=foo)'
            ]
        }
    ];

    vasync.forEachPipeline({
        func: runValidTestCase.bind(null, t),
        inputs: testCases
    }, function onAllValidTestCasesRan(err) {
        t.done();
    });
};

exports.close_clients = function (t) {
    morayClient.close();
    client.close();
    t.done();
};