/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

// In seconds
var TIMEOUT = 120;

function checkJob(t, job) {
    t.ok(job.uuid, 'uuid');
    t.ok(job.name, 'name');
    t.ok(job.execution, 'execution');
    t.ok(job.params, 'params');
}


function checkEqual(value, expected) {
    if ((typeof (value) === 'object') && (typeof (expected) === 'object')) {
        var exkeys = Object.keys(expected);
        for (var i = 0; i < exkeys.length; i++) {
            var key = exkeys[i];
            if (value[key] !== expected[key])
                return false;
        }

        return true;
    } else {
        return (value === expected);
    }
}


function checkValue(client, url, key, value, callback) {
    return client.get(url, function (err, req, res, body) {
        if (err) {
            return callback(err);
        }

        return callback(null, checkEqual(body[key], value));
    });
}

function waitForValue(client, url, key, value, callback) {
    var times = 0;

    function onReady(err, ready) {
        if (err) {
            callback(err);
            return;
        }

        if (!ready) {
            times++;

            if (times == TIMEOUT) {
                throw new Error('Timeout waiting on ' + url);
            } else {
                setTimeout(function () {
                    waitForValue(client, url, key, value, callback);
                }, 1000);
            }
        } else {
            times = 0;
            callback(null);
        }
    }

    return checkValue(client, url, key, value, onReady);
}

module.exports = {
    checkJob: checkJob,
    waitForValue: waitForValue
};
