/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var child_process = require('child_process');
var fs = require('fs');
var path = require('path');

var THROWING_VMAPI_SERVER = path.join(__dirname, 'fixtures',
    'vmapi-server-with-throwing-handler.js');
var SERVER_EXPECTED_STDERR = fs.readFileSync(path.join(__dirname, 'fixtures',
    'vmapi-server-throwing-expected-stderr.txt'));

exports.vmapi_aborts_on_restify_handler_uncaught_exception = function (t) {
    var child = child_process.spawn(process.execPath, [THROWING_VMAPI_SERVER]);
    var stderr = '';

    child.on('exit', function onChildExit(exitCode, signal) {
        t.strictEqual(stderr.indexOf(SERVER_EXPECTED_STDERR), 0,
            'server\'s stderr output should start with: ' +
                SERVER_EXPECTED_STDERR + ', and is: ' + stderr);
        t.strictEqual(exitCode, 1, 'exit code should be 1');
        t.done();
    });

    child.stderr.on('data', function onStderr(data) {
        stderr += data.toString();
    });

    child.on('error', function onError(childErr) {
        t.notOk(childErr, 'error event should not be emitted');
        t.done();
    });
};