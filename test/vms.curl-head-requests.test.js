/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

// This tests suite is mainly a regression tests suite for
// https://smartos.org/bugview/ZAPI-220.

var child_process = require('child_process');
var http = require('http');

var assert = require('assert-plus');
var once = require('once');

var VMAPI_IP = process.env.VMAPI_IP || '127.0.0.1';

function curlHeadRequest(path, headers, callback) {
    assert.string(path, 'path');
    assert.object(headers, 'headers');
    assert.func(callback, 'callback');

    var endpoint = 'http://' + VMAPI_IP + '/' + path;
    var CURL_CMD = ['curl', '-sS', '-i', endpoint, '-X', 'HEAD'];
    var headerName;

    for (headerName in headers) {
        CURL_CMD.push('-H');
        CURL_CMD.push('\'' + headerName + ': ' + headers[headerName] + '\'');
    }

    child_process.exec(CURL_CMD.join(' '), callback);
}

function nonCurlHeadRequest(path, headers, callback) {
    assert.string(path, 'path');
    assert.object(headers, 'headers');
    assert.func(callback, 'callback');

    var callbackOnce = once(callback);
    var reqParams = {
        hostname: VMAPI_IP,
        path: path,
        method: 'HEAD',
        headers: {
            'user-agent': 'foobar'
        }
    };
    var headerName;

    for (headerName in headers) {
        reqParams.headers[headerName] = headers[headerName];
    }

    var req = http.request(reqParams, function onResponse(res) {
        // destroy the socket explicitly now since the request was
        // explicitly requesting to not destroy the socket by setting
        // its connection header to 'keep-alive'.
        req.abort();
        callbackOnce(null, res.headers);
    });

    req.on('error', function onReqError(err) {
        callbackOnce(err);
    });

    req.end();
}

function headerInCurlOutput(output, headerName) {
    assert.string(output, 'output');
    assert.string(headerName, 'headerName');

    var lines = output.split(/\n/);
    var headerValue;
    var headerRegexp = new RegExp(headerName + ':\\s*(\\w+)');

    lines.some(function matchHeader(line) {
        var matches = line.match(headerRegexp);
        if (matches != null) {
            headerValue = matches[1];
            return true;
        }
        return false;
    });

    return headerValue;
}

exports.curl_headvms_connection_default_request = function (t) {
    curlHeadRequest('/vms', {}, function onHeadResponse(err, stdout, stderr) {
        var contentLengthHeaderNotPresent =
            headerInCurlOutput(stdout, 'Content-Length') == null;

        var connectionCloseHeaderPresent =
            headerInCurlOutput(stdout, 'Connection') === 'close';

        t.ok(contentLengthHeaderNotPresent,
            'content-length header must not be present in response');
        t.ok(connectionCloseHeaderPresent,
            'connection response header must be set to close');

        t.done();
    });
};

exports.curl_headvms_connection_keepalive_request = function (t) {
    curlHeadRequest('/vms', {
        connection: 'keep-alive'
    }, function onHeadResponse(err, stdout, stderr) {
        var contentLengthHeaderNotPresent =
            headerInCurlOutput(stdout, 'Content-Length') == null;

        var connectionCloseHeaderPresent =
            headerInCurlOutput(stdout, 'Connection') === 'close';

        t.ok(contentLengthHeaderNotPresent,
            'content-length header must not be present in response');
        t.ok(connectionCloseHeaderPresent,
            'connection response header must be set to close');

        t.done();
    });
};

exports.curl_headvms_connection_close_request = function (t) {
    curlHeadRequest('/vms', {
        connection: 'close'
    }, function onHeadResponse(err, stdout, stderr) {
        var contentLengthHeaderNotPresent =
            headerInCurlOutput(stdout, 'Content-Length') == null;

        var connectionCloseHeaderPresent =
            headerInCurlOutput(stdout, 'Connection') === 'close';

        t.ok(contentLengthHeaderNotPresent,
            'content-length header must not be present in response');
        t.ok(connectionCloseHeaderPresent,
            'connection response header must be set to close');

        t.done();
    });
};

exports.curl_headvm_connection_default_request = function (t) {
    curlHeadRequest('/vm', {}, function onHeadResponse(err, stdout, stderr) {
        var contentLengthHeaderNotPresent =
            headerInCurlOutput(stdout, 'Content-Length') == null;

        var connectionCloseHeaderPresent =
            headerInCurlOutput(stdout, 'Connection') === 'close';

        t.ok(contentLengthHeaderNotPresent,
            'content-length header must not be present in response');
        t.ok(connectionCloseHeaderPresent,
            'connection response header must be set to close');

        t.done();
    });
};

exports.curl_headvm_connection_keepalive_request = function (t) {
    curlHeadRequest('/vm', {
        connection: 'keep-alive'
    }, function onHeadResponse(err, stdout, stderr) {
        var contentLengthHeaderNotPresent =
            headerInCurlOutput(stdout, 'Content-Length') == null;

        var connectionCloseHeaderPresent =
            headerInCurlOutput(stdout, 'Connection') === 'close';

        t.ok(contentLengthHeaderNotPresent,
            'content-length header must not be present in response');
        t.ok(connectionCloseHeaderPresent,
            'connection response header must be set to close');

        t.done();
    });
};

exports.curl_headvm_connection_close_request = function (t) {
    curlHeadRequest('/vm', {
        connection: 'close'
    }, function onHeadResponse(err, stdout, stderr) {
        var contentLengthHeaderNotPresent =
            headerInCurlOutput(stdout, 'Content-Length') == null;

        var connectionCloseHeaderPresent =
            headerInCurlOutput(stdout, 'Connection') === 'close';

        t.ok(contentLengthHeaderNotPresent,
            'content-length header must not be present in response');
        t.ok(connectionCloseHeaderPresent,
            'connection response header must be set to close');

        t.done();
    });
};

exports.non_curl_headvms_connection_default_request = function (t) {
    nonCurlHeadRequest('/vms', {}, function onHeaders(err, headers) {
        t.ifError(err, 'request should not result in an error');

        t.ok(headers.hasOwnProperty('content-length'),
            'response must have content-length header');
        t.equal(headers.connection, 'close',
            'connection response header must be set to close');

        t.done();
    });
};

exports.non_curl_headvms_connection_keepalive_request = function (t) {
    nonCurlHeadRequest('/vms', {
        connection: 'keep-alive'
    }, function onHeaders(err, headers) {
        t.ifError(err, 'request should not result in an error');

        t.ok(headers.hasOwnProperty('content-length'),
            'response must have content-length header');
        t.equal(headers.connection, 'keep-alive',
            'connection response header must be set to keep-alive');

        t.done();
    });
};

exports.non_curl_headvms_connection_close_request = function (t) {
    nonCurlHeadRequest('/vms', {
        connection: 'close'
    }, function onHeaders(err, headers) {
        t.ifError(err, 'request should not result in an error');

        t.ok(headers.hasOwnProperty('content-length'),
            'response must have content-length header');
        t.equal(headers.connection, 'close',
            'connection response header must be set to close');

        t.done();
    });
};

exports.non_curl_headvm_connection_default_request = function (t) {
    nonCurlHeadRequest('/vm', {}, function onHeaders(err, headers) {
        t.ifError(err, 'request should not result in an error');

        t.ok(headers.hasOwnProperty('content-length'),
            'response must have content-length header');
        t.equal(headers.connection, 'close',
            'connection response header must be set to close');

        t.done();
    });
};

exports.non_curl_headvm_connection_keepalive_request = function (t) {
    nonCurlHeadRequest('/vm', {
        connection: 'keep-alive'
    }, function onHeaders(err, headers) {
        t.ifError(err, 'request should not result in an error');

        t.ok(headers.hasOwnProperty('content-length'),
            'response must have content-length header');
        t.equal(headers.connection, 'keep-alive',
            'connection response header must be set to keep-alive');

        t.done();
    });
};

exports.non_curl_headvm_connection_close_request = function (t) {
    nonCurlHeadRequest('/vm', {
        connection: 'close'
    }, function onHeaders(err, headers) {
        t.ifError(err, 'request should not result in an error');

        t.ok(headers.hasOwnProperty('content-length'),
            'response must have content-length header');
        t.equal(headers.connection, 'close',
            'connection response header must be set to close');

        t.done();
    });
};
