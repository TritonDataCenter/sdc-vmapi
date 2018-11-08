/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */


var buffer = require('buffer');
var net = require('net');
var stream = require('stream');
var timers = require('timers');
var util = require('util');

var assert = require('assert-plus');
var restify = require('restify');
var vasync = require('vasync');


function migration_sync(job, cb) {

    var action = job.params.migrationTask.action;
    if (action !== 'sync') {
        cb(null, 'OK - not applicable for action ' + action);
        return;
    }

// // // // // // // // //
//   node-byline START  //
// // // // // // // // //

// license: MIT
// module: https://github.com/jahewson/node-byline/
//
// Copyright (C) 2011-2015 John Hewson
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
// IN THE SOFTWARE.
//
// Using the new node v0.10 "streams2" API:
//
    function LineStream(options) {
        stream.Transform.call(this, options);
        options = options || {};

        // use objectMode to stop the output from being buffered
        // which re-concatanates the lines, just without newlines.
        this._readableState.objectMode = true;
        this._lineBuffer = [];
        this._keepEmptyLines = options.keepEmptyLines || false;
        this._lastChunkEndedWithCR = false;

        // take the source's encoding if we don't have one
        var self = this;
        this.on('pipe', function LS_onPipe(src) {
            if (!self.encoding) {
                // but we can't do this for old-style streams
                if (src instanceof stream.Readable) {
                    self.encoding = src._readableState.encoding;
                }
            }
        });
    }
    util.inherits(LineStream, stream.Transform);

    LineStream.prototype._transform = function LS_Trans(chunk, encoding, done) {
        // decode binary chunks as UTF-8
        encoding = encoding || 'utf8';

        if (buffer.Buffer.isBuffer(chunk)) {
            if (encoding == 'buffer') {
                chunk = chunk.toString(); // utf8
                encoding = 'utf8';
            } else {
                chunk = chunk.toString(encoding);
            }
        }
        this._chunkEncoding = encoding;

        // see: http://www.unicode.org/reports/tr18/#Line_Boundaries
        var lines = chunk.split(/\r\n|[\n\v\f\r\x85\u2028\u2029]/g);

        // don't split CRLF which spans chunks
        if (this._lastChunkEndedWithCR && chunk[0] == '\n') {
            lines.shift();
        }

        if (this._lineBuffer.length > 0) {
            this._lineBuffer[this._lineBuffer.length - 1] += lines[0];
            lines.shift();
        }

        this._lastChunkEndedWithCR = chunk[chunk.length - 1] == '\r';
        this._lineBuffer = this._lineBuffer.concat(lines);
        this._pushBuffer(encoding, 1, done);
    };

    LineStream.prototype._pushBuffer = function LS_pushB(encoding, keep, done) {
        // always buffer the last (possibly partial) line
        while (this._lineBuffer.length > keep) {
            var line = this._lineBuffer.shift();
            // skip empty lines
            if (this._keepEmptyLines || line.length > 0) {
                if (!this.push(line)) {
                    // when the high-water mark is reached, defer pushes until
                    // the next tick
                    var self = this;
                    timers.setImmediate(function LS_setImmPushB() {
                        self._pushBuffer(encoding, keep, done);
                    });
                    return;
                }
            }
        }
        done();
    };

    LineStream.prototype._flush = function LS_flush(done) {
        this._pushBuffer(this._chunkEncoding, 0, done);
    };

// // // // // // // // //
//    node-byline END   //
// // // // // // // // //

    var record = job.params.migrationTask.record;
    var progressIdx = job.params.migrationTask.progressIdx;

    // Ensure a valid cn-agent source process.
    assert.object(record.source_process_details,
        'record.source_process_details');
    assert.string(record.source_process_details.host,
        'record.source_process_details.host');
    assert.number(record.source_process_details.pid,
        'record.source_process_details.pid');
    assert.number(record.source_process_details.port,
        'record.source_process_details.port');

    // Ensure a valid cn-agent target process.
    assert.object(record.target_process_details,
        'record.target_process_details');
    assert.string(record.target_process_details.host,
        'record.target_process_details.host');
    assert.number(record.target_process_details.pid,
        'record.target_process_details.pid');
    assert.number(record.target_process_details.port,
        'record.target_process_details.port');

    assert.number(progressIdx, 'progressIdx');
    assert.ok(progressIdx >= 0, 'progressIdx >= 0');
    assert.arrayOfObject(record.progress_history, 'record.progress_history');
    assert.ok(record.progress_history.length > progressIdx,
        'record.progress_history.length > progressIdx');

    var endedSuccessfully = false;
    var eventId = 1;
    var pendingCallbacks = {};
    var log = job.log;
    var host = record.source_process_details.host;
    var port = record.source_process_details.port;
    var progressEntry = record.progress_history[progressIdx];
    var progressPending = false;
    var ranCallback = false;

    var sock = net.createConnection({ host: host, port: port });

    sock.setTimeout(5 * 60 * 1000);  // 5 minutes

    log.debug({source_process_details: record.source_process_details},
        'migration_sync: connecting to cn-agent process');

    sock.on('error', function _onSocketError(err) {
        log.warn('migration_sync: socket error:', err);
        if (ranCallback) {
            return;
        }
        ranCallback = true;
        cb(err);
    });

    sock.on('timeout', function _onSocketTimeout() {
        log.warn('migration_sync: socket timeout');
        if (ranCallback) {
            return;
        }
        ranCallback = true;
        cb(new Error('watch socket timeout'));
    });

    sock.on('connect', function _onSocketConnect() {
        log.debug('migration_sync: cn-agent process socket connected');

        startLineReader();
        runAction();
    });

    function onProgress(event) {
        assert.number(event.current, 'event.current');
        assert.number(event.total, 'event.total');

        progressEntry.current_progress = event.current;
        progressEntry.total_progress = event.total;

        if (progressPending) {
            // Whilst there is a pending progress notification, just ignore
            // these events. Eventually this will free up, or we'll receive a
            // finish event.
            // XXX: TODO: Change to log.trace
            log.debug('Already a pending progress event - ignoring this event');
            return;
        }

        progressPending = true;

        // XXX: TODO: Change to log.trace
        log.debug({event: event}, 'onProgress: %d%%',
            Math.round(event.currentProgress / event.totalProgress * 100));

        var rawVmapi = restify.createJsonClient({
            connectTimeout: 10 * 1000, // 10 seconds
            requestTimeout: 30 * 1000, // 30 seconds
            headers: { 'x-request-id': job.params['x-request-id'] },
            log: log,
            retry: false,
            url: vmapiUrl
        });
        var url = '/vms/' + job.params.vm_uuid +
            '?action=migrate&migration_action=notifyProgress';

        rawVmapi.post(url, event, function _onNotifyProgressCb(err) {
            progressPending = false;
            if (err) {
                log.warn({err: err, event: event},
                    'Error in vmapi notify progress request: ' + err);
            }
            // Intentially no callback here.
        });
    }

    function runAction() {
        if (action === 'sync') {
            runSync();
        }
    }

    function runSync() {
        // Start the requested action in the cn-agent process.
        vasync.pipeline({arg: {}, funcs: [

            function _sendMigrationRecord(ctx, next) {
                log.info('runSync:: set migration record');
                var event = {
                    command: 'set-record',
                    record: record
                };
                sendSockEvent(event, next);
            },

            function _runZfsSync(ctx, next) {
                log.info('runSync:: sync');
                var event = {
                    command: 'sync',
                    host: record.target_process_details.host,
                    port: record.target_process_details.port
                };
                sendSockEvent(event, function _startSyncCb(err) {
                    if (err) {
                        next(err);
                        return;
                    }
                    next();
                });
            },

            function _sendEnd(ctx, next) {
                log.info('runSync:: send end');
                sendSockEvent({command: 'end'},
                        function _endCb(err) {
                    if (err) {
                        next(err);
                        return;
                    }
                    endedSuccessfully = true;
                    next();
                });
            }
        ]}, function _syncPipelineCb(err) {
            if (ranCallback) {
                log.warn({err: err},
                    'Sync pipeline error - callback already fired - ignoring');
                return;
            }
            ranCallback = true;
            if (err) {
                log.error({err: err}, 'Sync pipeline error - ending wf');
                sendSockEvent({command: 'stop'}, function _onStopCb(stopErr) {
                    // Ignore any return callback errors.
                    log.info('Got stop callback, stopErr: ', stopErr);
                    sock.destroy();
                });
                cb('Error - ' + err);
                return;
            }
            cb(null, 'OK - sync was successful');
        });
    }

    function sendSockEvent(event, callback) {
        assert.object(event, 'event');
        assert.string(event.command, 'event.command');
        assert.func(callback, 'callback');

        pendingCallbacks[eventId] = callback;
        event.type = 'request';
        event.eventId = eventId;
        eventId += 1;
        sock.write(JSON.stringify(event) + '\n');
    }

    function startLineReader() {
        var lstream = new LineStream(LineStream);

        lstream.on('end', function _onLstreamEnd() {
            log.info({endedSuccessfully: endedSuccessfully},
                'migration_sync: lstream ended');
            if (!endedSuccessfully) {
                cb('Error - cn-agent process did not send "end" event');
                return;
            }
        });

        lstream.on('readable', function _readLines() {
            var line;
            while (null !== (line = lstream.read())) {
                processOneResponse(line);
            }
        });

        sock.pipe(lstream);
    }

    function processOneResponse(line) {
        var event;

        log.trace('processOneResponse:: line: %s', line);

        try {
            event = JSON.parse(line);
        } catch (ex) {
            log.warn('Ignoring bad JSON line:', line);
            return;
        }

        assert.string(event.type, 'event.type');

        if (event.type === 'progress') {
            onProgress(event);
            return;
        }

        assert.number(event.eventId, 'event.eventId');
        assert.func(pendingCallbacks[event.eventId],
            'pendingCallbacks[event.eventId]');

        var callback = pendingCallbacks[event.eventId];
        delete pendingCallbacks[event.eventId];

        assert.func(callback, 'pendingCallbacks[event.eventId]');

        if (event.type === 'error') {
            log.error({event: event},
                'received "error" event from cn-agent source process');
            callback(new Error(event.message));
            return;
        }

        assert.equal(event.type, 'response');

        callback(null, event);
    }
}


module.exports = {
    name: 'migration_sync',
    timeout: 180,
    // retry: 1,
    body: migration_sync,
    modules: {
        assert: 'assert-plus',
        buffer: 'buffer',
        net: 'net',
        restify: 'restify',
        stream: 'stream',
        timers: 'timers',
        util: 'util',
        vasync: 'vasync'
    }
};
