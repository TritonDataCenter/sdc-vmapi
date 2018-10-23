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


function migration_watch(job, cb) {

    var action = job.params.migrationTask.action;
    if (action === 'start') {
        cb(null, 'OK - not applicable for action ' + action);
        return;
    }

//
// node-byline START
//
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

//
// node-byline END
//

    var record = job.params.migrationTask.record;

    assert.object(record.process_details, 'record.process_details');
    assert.string(record.process_details.host, 'record.process_details.host');
    assert.number(record.process_details.pid, 'record.process_details.pid');
    assert.number(record.process_details.port, 'record.process_details.port');

    var endedSuccessfully = false;
    var host = record.process_details.host;
    var log = job.log;
    var port = record.process_details.port;

    var sock = net.createConnection({ host: host, port: port });

    sock.setTimeout(5 * 60 * 1000);  // 5 minutes

    log.debug({process_details: record.process_details},
        'migration_watch: connecting to cn-agent process');

    sock.on('error', function _onSocketError(err) {
        log.warn('migration_watch: socket error:', err);
        cb(err);
    });

    sock.on('connect', function _onSocketConnect() {
        log.debug('migration_watch: cn-agent process socket connected');
        readLines();
        sendSockEvent({type: action});
    });

    function sendSockEvent(event) {
        sock.write(JSON.stringify(event) + '\n');
    }

    function readLines() {
        var lstream = new LineStream(LineStream);

        lstream.on('end', function _onLstreamEnd() {
            log.info({endedSuccessfully: endedSuccessfully},
                'migration_watch: lstream ended');
            if (!endedSuccessfully) {
                cb('Error - cn-agent process did not send "end" event');
                return;
            }
        });

        lstream.on('readable', function _readLines() {
            var line;
            while (null !== (line = lstream.read())) {
                processOneLine(line);
            }
        });

        sock.pipe(lstream);
    }

    function processOneLine(line) {
        var event;

        try {
            event = JSON.parse(line);
        } catch (ex) {
            log.warn('Ignoring bad JSON line:', line);
            return;
        }

        switch (event.type) {
            case 'progress':
                break;
            case 'pong':
                break;
            case 'stop':
                log.info('received "stop" event from cn-agent process');
                endedSuccessfully = true;
                sock.destroy();
                cb(null, 'OK - watch received "stop" event');
                break;
            case 'end':
                log.info('received "end" event from cn-agent process');
                endedSuccessfully = true;
                sock.destroy();
                cb(null, 'OK - watch received "end" event');
                break;
            default:
                log.warn({event: event}, 'Ignoring unknown JSON event:', line);
                break;
        }
    }
}


module.exports = {
    name: 'migration_watch',
    timeout: 180,
    retry: 2,
    body: migration_watch,
    modules: {
        assert: 'assert-plus',
        buffer: 'buffer',
        net: 'net',
        stream: 'stream',
        timers: 'timers',
        util: 'util'
    }
};
