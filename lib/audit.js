// Copyright 2013 Joyent, Inc.  All rights reserved.

var assert = require('assert-plus');
var bunyan = require('bunyan');


///--- API

/**
 * Returns a Bunyan audit logger suitable to be used in a server.on('after')
 * event.  I.e.:
 *
 * server.on('after', restify.auditLogger({ log: myAuditStream }));
 *
 * This logs at the INFO level.
 *
 * @param {Object} options at least a bunyan logger (log).
 * @return {Function} to be used in server.after.
 */
function auditLogger(options) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');

    var log = options.log.child({
        audit: true,
        serializers: {
            err: bunyan.stdSerializers.err,
            req: function auditRequestSerializer(req) {
                if (!req)
                    return (false);

                var timers = {};
                (req.timers || []).forEach(function (time) {
                    var t = time.time;
                    var _t = Math.floor((1000000 * t[0]) +
                                        (t[1] / 1000));
                    timers[time.name] = _t;
                });
                return ({
                    method: req.method,
                    url: req.url,
                    headers: req.headers,
                    httpVersion: req.httpVersion,
                    version: req.version,
                    body: options.body === true ?
                        req.body : undefined,
                    timers: timers
                });
            },
            res: function auditResponseSerializer(res) {
                if (!res)
                    return (false);

                return ({
                    statusCode: res.statusCode,
                    headers: res._headers,
                    body: options.body === true ?
                        res._body : undefined
                });
            }
        }
    });

    function audit(req, res, route, err) {
        if (req.path() === '/ping')
            return;

        var latency = res.getHeader('X-Response-Time');
        if (typeof (latency) !== 'number')
            latency = Date.now() - req._time;

        var reqHeaderLength = 0;
        Object.keys(req.headers).forEach(function (k) {
            reqHeaderLength +=
            Buffer.byteLength('' + req.headers[k]) +
                Buffer.byteLength(k);
        });

        var resHeaderLength = 0;
        var resHeaders = res.headers();
        Object.keys(resHeaders).forEach(function (k) {
            resHeaderLength +=
            Buffer.byteLength('' + resHeaders[k]) +
                Buffer.byteLength(k);
        });

        var name = route ? (route.name || route) : 'unknown';
        var obj = {
            _audit: true,
            operation: name,
            remoteAddress: req.connection.remoteAddress,
            remotePort: req.connection.remotePort,
            req_id: req.getId(),
            reqHeaderLength: reqHeaderLength,
            resHeaderLength: resHeaderLength,
            req: req,
            res: res,
            err: err,
            latency: latency,
            secure: req.secure
        };

        log.info(obj, 'handled: %d', res.statusCode);

        return (true);
    }

    return (audit);
}



///-- Exports

module.exports = {
    auditLogger: auditLogger
};
