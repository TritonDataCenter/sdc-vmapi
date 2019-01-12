/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */


var net = require('net');

var assert = require('assert-plus');
var restify = require('restify');
var vasync = require('vasync');


function migration_cleanup_old_source_processes(job, cb) {
    var action = job.params.migrationTask.action;
    var record = job.params.migrationTask.record;
    var cbMsg = null;
    var log = job.log;

    if (!record || !record.source_process_details ||
            record.source_process_details.pid === -1) {
        cb(null, 'OK - no source_process_details in the migration record');
        return;
    }

    if (action !== 'sync' && action !== 'pause') {
        cb(null, 'OK - not applicable for action ' + action);
        return;
    }

    assert.object(record.source_process_details,
        'record.source_process_details');
    assert.string(record.source_process_details.host,
        'record.source_process_details.host');
    assert.number(record.source_process_details.pid,
        'record.source_process_details.pid');
    assert.number(record.source_process_details.port,
        'record.source_process_details.port');

    vasync.pipeline({arg: {}, funcs: [
        // Connect to the source host:port and ask nicely for it to stop.
        function _nicelyStopSourceProcesses(ctx, next) {
            var data = '';
            var endedSuccessfully = false;
            var errMsg = null;
            var host = record.source_process_details.host;
            var port = record.source_process_details.port;

            var sock = new net.Socket();

            sock.setTimeout(2 * 60 * 1000);  // 2 minutes

            log.debug({source_process_details: record.source_process_details},
                'migration_cleanup: connecting to cn-agent process');

            sock.on('error', function _onSocketError(err) {
                if (err.code === 'ECONNREFUSED') {
                    // This is normal - the process probably isn't running.
                    log.info('migration_cleanup: socket not listening');
                    next();
                    return;
                }
                log.warn('migration_cleanup: socket error:', err);
                // Continue to the next vasync pipeline function.
                sock.destroy();
                next();
            });

            sock.on('timeout', function _onSocketTimeout() {
                log.warn('migration_cleanup: socket timeout');
                // Continue to the next vasync pipeline function.
                sock.destroy();
                next();
            });

            sock.on('readable', function _onSockReadable() {
                var chunk;
                while (null !== (chunk = sock.read())) {
                    data += String(chunk);
                }
            });

            function processResponse() {
                var event;

                try {
                    event = JSON.parse(data);
                } catch (ex) {
                    log.warn('Ignoring bad JSON data:', data);
                    return;
                }

                assert.string(event.type, 'event.type');

                if (event.type === 'error') {
                    log.error({event: event},
                        'received "error" event from cn-agent source process');
                    errMsg = event.message;
                    sock.destroy();
                    return;
                }

                assert.equal(event.type, 'response');

                switch (event.command) {
                    case 'end':
                        log.info('received "end" from cn-agent source process');
                        endedSuccessfully = true;
                        sock.destroy();
                        break;
                    default:
                        log.warn({event: event},
                            'Ignoring unknown JSON event:', data);
                        break;
                }
            }

            sock.on('end', function _onSockEnd() {
                processResponse();

                log.info({endedSuccessfully: endedSuccessfully, errMsg: errMsg},
                    'migration_cleanup: sock ended');

                if (errMsg) {
                    next(new Error(errMsg));
                    return;
                }

                if (!endedSuccessfully) {
                    next(new Error('No "end" event from cn-agent process'));
                    return;
                }

                ctx.endedSuccessfully = true;
                cbMsg = 'OK - source process ended successfully';
                next(null);
            });

            function sendSockEvent(event) {
                event.type = 'request';
                sock.write(JSON.stringify(event) + '\n');
            }

            function onSockConnect() {
                log.debug(
                    'migration_cleanup: cn-agent process socket connected');
                sendSockEvent({command: 'stop'});
            }

            sock.connect({host: host, port: port}, onSockConnect);
        },

        // If nice didn't work - go an kill it.
        function _killSourceProcesses(ctx, next) {
            var pid = record.source_process_details.pid;

            if (ctx.endedSuccessfully || pid === -1) {
                next();
                return;
            }

            var cnapi = restify.createJsonClient({
                url: cnapiUrl,
                headers: { 'x-request-id': job.params['x-request-id'] }
            });
            var url = '/servers/' +
                job.params['server_uuid'] + '/vms/' +
                job.params['vm_uuid'] + '/migrate';
            var payload = {
                action: 'kill_migration_process',
                migrationTask: {
                    action: action,
                    record: record
                },
                pid: pid
            };

            cnapi.post(url, payload, next);
        }
    ]}, function _pipelineCb(err) {
        if (err) {
            cb(err);
            return;
        }
        cb(null, cbMsg || 'OK - source process is ended');
    });
}


module.exports = {
    name: 'migration_cleanup_old_source_processes',
    timeout: 180,
    retry: 2,
    body: migration_cleanup_old_source_processes,
    modules: {
        assert: 'assert-plus',
        net: 'net',
        restify: 'restify',
        vasync: 'vasync'
    }
};
