/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * A brief overview of this source file: what is its purpose.
 */


var assert = require('assert-plus');
var once = require('once');
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
    assert.object(publisher, 'publisher');
    assert.string(resource, 'resource');
    assert.arrayOfString(subResources, 'subResources');
    assert.uuid(uuid, 'uuid');
    assert.func(cb, 'cb');

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
 * Poll a job until it reaches either the succeeded or failed state.
 *
 * Note: if a job fails, it's the caller's responsibility to check for a failed
 * job.  The error object will be null even if the job fails.
 */

function pollJob(opts, callback) {
    var wfapi = opts.wfapi;
    var log = opts.log;
    var job_uuid = opts.job_uuid;
    var workflowListener = opts.moray.workflowListener;

    var attempts = 0;
    var callbackFired = false;
    var jobCompletedStates = ['succeeded', 'failed', 'canceled'];
    var errors = 0;

    var timeoutId = -1;
    var timeout = 5000;  // 5 seconds
    var limit = 720;     // 1 hour

    function cb(err, job) {
        log.trace({err: err, job_uuid: job_uuid, job_execution: job.execution},
            'pollJob finished');
        callbackFired = true;
        if (workflowListener) {
            workflowListener.removeListener(job_uuid, notificationHandler);
        }
        clearTimeout(timeoutId);
        callback(err, job);
    }
    cb = once(cb);

    function notificationHandler(event) {
        assert.ok(event.uuid === job_uuid, 'Should only get job uuid events');

        log.trace({event: event}, 'Received workflow status notification');
        if (jobCompletedStates.indexOf(event.execution) !== -1) {
            // Fake job - enough that waitForJob gets what it needs.
            var job = {
                chain_results: [event.lastResult]
            };
            cb(null, job);
        }
    }

    if (workflowListener) {
        log.trace({job_uuid: job_uuid}, 'pollJob: listening for notifications');
        workflowListener.on(job_uuid, notificationHandler);
    } else {
        log.warn('pollJob: no workflow listener available');
    }

    log.info('polling job %s', job_uuid);

    var poll = function () {
        wfapi.getJob(job_uuid, function (err, job) {
            attempts++;

            if (callbackFired) {
                // We already received the workflow status notification.
                return;
            }

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
                    timeoutId = setTimeout(poll, timeout);
                    return (null);
                }
            }

            log.debug({ job: job }, 'polling job %s (attempt %d)',
                      job_uuid, attempts);

                      if (job && job.execution === 'succeeded') {
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

                      timeoutId = setTimeout(poll, timeout);
                      return (null);
        });
    };

    poll();
}



/**
 * Waits for a given workflow to reach completion.
 */
exports.waitForJob = function (opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.job_uuid, 'opts.job_uuid');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.moray, 'opts.moray');
    assert.object(opts.wfapi, 'opts.wfapi');
    assert.func(cb, 'cb');

    var job_uuid = opts.job_uuid;
    var log = opts.log;

    log.info('waiting for job %s', job_uuid);

    pollJob.call(null, opts, function (err, job) {
        if (err)
            return (cb(err));

        var result = job.chain_results.pop();

        if (result.error) {
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
