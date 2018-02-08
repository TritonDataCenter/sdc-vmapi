/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
 */

/*
 * Artedi metrics.
 */

var artedi = require('artedi');
var assert = require('assert-plus');
var restify = require('restify');
var VError = require('verror');

function getMetricsHandler(collector) {
    function getMetrics(req, res, next) {
        /*
         * Restify GET requests will keep socket open until entire request
         * body is read. req.resume() is used to prevent connection leaks.
         *
         * More information at:
         * https://jira.joyent.us/browse/MANTA-3338
         * https://cr.joyent.us/#/c/2823/1/lib/other.js
         */
        req.on('end', function collectMetrics() {
            collector.collect(artedi.FMT_PROM,
                function sendMetrics(err, metrics) {
                if (err) {
                    next(new VError(err, 'error retrieving metrics'));
                    return;
                }
                /* BEGIN JSSTYLED */
                /*
                 * Content-Type header is set to indicate the Prometheus
                 * exposition format version
                 *
                 * More information at:
                 * https://github.com/prometheus/docs/blob/master/content/docs/instrumenting/exposition_formats.md#format-version-004
                 */
                /* END JSSTYLED */
                res.setHeader('Content-Type', 'text/plain; version=0.0.4');
                res.send(metrics);
                next();
            });
        });
        req.resume();
    }
    var chain = [ getMetrics ];
    return chain;
}

function MetricsManager(config) {
    assert.object(config, 'config');
    assert.object(config.log, 'config.log');
    assert.object(config.labels, 'config.labels');
    assert.string(config.address, 'config.address');
    assert.number(config.port, 'config.port');

    var collector = artedi.createCollector({ labels: config.labels });
    this.collector = collector;

    this.requestCounter = this.collector.counter({
        name: 'http_requests_completed',
        help: 'count of requests completed'
    });

    this.timeHistogram = this.collector.histogram({
        name: 'http_request_duration_seconds',
        help: 'total time to process requests'
    });

    this.address = config.address;
    this.log = config.log;
    this.port = config.port;
    this.server = restify.createServer({ severName: 'Metrics' });
    this.server.get('/metrics', getMetricsHandler(collector));
}

MetricsManager.prototype.listen = function startMetricsServer(callback) {
    var self = this;

    self.server.listen(self.port, self.address, function serverStarted() {
        self.log.info('metrics server started on port %d', self.port);
        callback();
    });
};

MetricsManager.prototype.update = function updateMetrics(req, res, route, err) {

    var routeName = route ? (route.name || route) : 'unknown';
    var userAgent = req.userAgent();

    // Only the first token is added to the label to prevent cardinality issues
    var shortUserAgent = userAgent ? userAgent.split(' ')[0] : 'unknown';

    var labels = {
        route: routeName,
        method: req.method,
        user_agent: shortUserAgent,
        status_code: res.statusCode
    };

    var latency = res.getHeader('X-Response-Time');
    if (typeof (latency) !== 'number') {
        latency = Date.now() - req._time;
    }

    var latencySeconds = latency / 1000;

    this.requestCounter.increment(labels);
    this.timeHistogram.observe(latencySeconds, labels);
};

function createMetricsManager(options) {
    return new MetricsManager(options);
}

module.exports = {
    createMetricsManager: createMetricsManager
};
