/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2021 Joyent, Inc.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var jsprim = require('jsprim');
var moray = require('moray');
var restify = require('restify');
var uuid = require('uuid');
var vasync = require('vasync');
var verror = require('verror');

var common = require('../common');

function getDefaultBucketsConfig(suffix) {
    return {
        vms: {
            name: 'test_vmapi_vms_' + suffix,
            schema: {
                index: {
                    uuid: { type: 'string', unique: true}
                }
            }
        },
        server_vms: {
            name: 'test_vmapi_server_vms_' + suffix,
            schema: {}
        },
        vm_role_tags: {
            name: 'test_vmapi_vm_role_tags_' + suffix,
            schema: {
                index: {
                    role_tags: { type: '[string]' }
                }
            }
        },
        vm_migrations: {
            name: 'test_vmapi_vm_migrations_' + suffix,
            schema: {}
        }
    };
}

/*
 * Deletes all buckets whose name is present in the "bucketsName" array. When
 * done or when if an error is encountered, calls the function "callback" with
 * an optional parameter, which is the error that was encountered if any.
 */
function cleanupLeftoverBuckets(bucketsName, callback) {
    assert.arrayOfString(bucketsName, 'bucketsName');
    assert.func(callback, 'callback');

    var morayClientOpts = jsprim.deepCopy(common.config.moray);
    morayClientOpts.log = bunyan.createLogger({
        name: 'moray-client',
        level: common.config.logLevel,
        serializers: restify.bunyan.serializers
    });

    var morayClient = moray.createClient(morayClientOpts);

    morayClient.on('connect', function onMorayClientConnected() {
        vasync.forEachParallel({
            func: function deleteBucket(bucketName, done) {
                morayClient.delBucket(bucketName, done);
            },
            inputs: bucketsName
        }, function onAllLeftoverBucketsDeleted(deleteErrs) {
            var unexpectedErrs;
            var forwardedMultiErr;

            morayClient.close();

            if (deleteErrs) {
                unexpectedErrs =
                    deleteErrs.ase_errors.filter(filterBucketNotFoundErr);

                if (unexpectedErrs && unexpectedErrs.length > 0) {
                    forwardedMultiErr =
                        new verror.MultiError(unexpectedErrs);
                }
            }

            callback(forwardedMultiErr);
        });
    });

    function filterBucketNotFoundErr(err) {
        assert.object(err, 'err');
        return !verror.hasCauseWithName(err, 'BucketNotFoundError');
    }
}

function writeObjects(morayClient, bucketName, valueTemplate, nbObjects,
    callback) {
    assert.object(morayClient, 'morayClient');
    assert.string(bucketName, 'bucketName');
    assert.object(valueTemplate, 'valueTemplate');
    assert.number(nbObjects, 'nbObjects');
    assert.func(callback, 'callback');

    var i;

    var requests = [];
    for (i = 0; i < nbObjects; ++i) {
        var newObjectValue = jsprim.deepCopy(valueTemplate);
        var newObjectUuid = uuid.v4();
        newObjectValue.uuid = newObjectUuid;
        requests.push({
            bucket: bucketName,
            key: newObjectUuid,
            operation: 'put',
            value: newObjectValue,
            option: {
                etag: null
            }
        });
    }

    /*
     * noBucketCache: true is needed so that when putting objects in
     * moray after a bucket has been deleted and recreated, it doesn't
     * use an old bucket schema and determine that it needs to update an
     * _rver column that doesn't exist anymore.
     */
    morayClient.batch(requests, {
        noBucketCache: true
    }, callback);
}

module.exports = {
    getDefaultBucketsConfig: getDefaultBucketsConfig,
    cleanupLeftoverBuckets: cleanupLeftoverBuckets,
    writeObjects: writeObjects
};
