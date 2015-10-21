/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * A brief overview of this source file: what is its purpose.
 */


var assert = require('assert-plus');
var vmapierrors = require('../errors');
var sprintf = require('sprintf').sprintf;

/*
 * Shallow clone
 */
function clone(obj) {
    if (null === obj || 'object' != typeof (obj)) {
        return obj;
    }

    var copy = obj.constructor();

    for (var attr in obj) {
        if (obj.hasOwnProperty(attr)) {
            copy[attr] = obj[attr];
        }
    }
    return copy;
}

exports.clone = clone;



/*
 * Simple object merge
 *   merge(a, b) will merge b attributes into a
 */
function simpleMerge(a, b) {
    if (!a || typeof (a) !== 'object') {
        throw new TypeError('First object is required (object)');
    }
    if (!b || typeof (b) !== 'object') {
        throw new TypeError('Second object is required (object)');
    }

    var newA = clone(a);
    var bkeys = Object.keys(b);

    bkeys.forEach(function (key) {
        newA[key] = b[key];
    });

    return newA;
}

exports.simpleMerge = simpleMerge;



/*
 * Shallow comparison of two objects. ignoreKeys can be an array of keys that
 * the comparison should ignore if needed
 */
exports.shallowEqual = function (a, b, ignoreKeys) {
    var akeys = Object.keys(a);
    var bkeys = Object.keys(b);

    if (!ignoreKeys) ignoreKeys = [];
    if (akeys.length != bkeys.length) {
        return false;
    }

    for (var i = 0; i < akeys.length; i++) {
        var key = akeys[i];

        if (ignoreKeys.indexOf(key) == -1 && (a[key] != b[key])) {
            return false;
        }
    }

    return true;
};



/*
 * Creates a YYYYMMDD date string
 */
exports.timestamp = function (aDate) {
    var date;

    if (aDate) {
        date = aDate;
    } else {
        date = new Date();
    }

    var month = date.getMonth() + 1;
    month = (month < 9 ? '0' + month : month.toString());

    return date.getFullYear().toString() +
           month +
           date.getDate().toString();
};



/**
 * Publishes a change feed item with the provided Publisher.
 * @param  {Publisher} publisher    Publisher module via changefeed
 * @param  {string}    resource     Identifies the resource e.g. 'vms'
 * @param  {array}     subResources Strings of resource properties e.g ['nics']
 * @param  {string}    uuid         UUID of the changed resource
 * @param  {function}  cb           callback function which takes err param
 */
function publishChange(publisher, resource, subResources, uuid, cb) {
    var changeItem = {
        changeKind: {
            resource: resource,
            subResources: subResources
        },
        changedResourceId: uuid
    };

    publisher.publish(changeItem, cb);
}

exports.publishChange = publishChange;



/*
 * Poll a job until it:
 * - reaches either the succeeded or failed state
 * - completes a given task
 *
 * 'opts' is an options object whose properties can be:
 * - 'taskName': a string that identifies the nane of the task to wait for
 * before calling the callback 'cb'. If 'opts.taskName' is set, then pollJob
 * will not wait for the whole job to succeed or fail, but instead will just
 * wait for that specific task to complete.
 *
 * Note: if a job fails, it's the caller's responsibility to check for a failed
 * job.  The error object will be null even if the job fails.
 */

function pollJob(opts, cb) {
    assert.object(opts, 'opts must be an object');
    assert.optionalString(opts.taskName,
        'opts.taskName must be undefined or a string');

    var wfapi = opts.wfapi;
    var log = opts.log;
    var job_uuid = opts.job_uuid;

    var attempts = 0;
    var errors = 0;

    var timeout = 5000;  // 5 seconds
    var limit = 720;     // 1 hour

    log.info('polling job %s', job_uuid);

    var poll = function () {
        wfapi.getJob(job_uuid, function (err, job) {
            attempts++;

            if (err) {
                errors++;

                log.warn(err, 'failed to get job %s ' +
                         '(attempt %d, error %d)',
                job_uuid, attempts, errors);

                if (errors >= 5) {
                    log.error(err,
                              'failed to wait for job %s',
                              job_uuid);
                              return (cb(err));
                } else {
                    return (setTimeout(poll, timeout));
                }
            }

            log.debug({ job: job }, 'polling job %s (attempt %d)',
                      job_uuid, attempts);

            if (opts.taskName &&
                job.execution === 'running' &&
                job.chain_results &&
                job.chain_results.some(function findTaskResultByName(result) {
                    return result && result.name === opts.taskName;
                })) {
                return cb(null, job);
            } else if (job && job.execution === 'succeeded') {
              return (cb(null, job));
            } else if (job && job.execution === 'failed') {
              log.warn('job %s failed', job_uuid);
              return (cb(null, job));
            } else if (job && job.execution === 'canceled') {
              log.warn('job %s was canceled', job_uuid);
              return (cb(null, job));
            } else if (attempts > limit) {
              log.warn('polling for job %s completion ' +
                       'timed out after %d seconds',
              job_uuid, limit * (timeout / 1000));
              return (cb(new Error(
                  'polling for job timed out'), job));
            }

            setTimeout(poll, timeout);
            return (null);
        });
    };

    poll();
}



/**
 * Waits for a given workflow to reach completion.
 */
exports.waitForJob = function (opts, cb) {
    var job_uuid = opts.job_uuid;
    var log = opts.log;

    assert.string(job_uuid, 'job_uuid');
    var errors = opts.errors || [];

    assert.func(cb, 'cb');

    log.info('waiting for job %s', job_uuid);

    pollJob.call(null, opts, function (err, job) {
        if (err)
            return (cb(err));

        var result = job.chain_results.pop();

        if (result.error) {
            var err_name = result.error.name;
            for (var i = 0; i < errors.length; i++) {
                if (err_name === errors[i]) {
                    log.warn('job failed with error %s; ' +
                             'ignoring expected error',
                    errors[i]);
                    return (cb(null));
                }
            }

            var m = sprintf('job %s (%s) failed: %s: %s',
                            job.name, job_uuid, result.name,
                            result.error);
            m = result.error.message ? result.error.message : m;

            return cb(vmapierrors.wfapiWrap({
                error: result.error,
                message: m
            }));
        }

        cb(null);
    });
};
