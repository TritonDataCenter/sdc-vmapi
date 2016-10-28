/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * Main entry-point for the VMs API.
 */

var restify = require('restify');
var Logger = require('bunyan');
var util = require('util');
var assert = require('assert-plus');
var async = require('async');
var trace_event = require('trace-event');
var changefeed = require('changefeed');

var EffluentLogger = require('effluent-logger');

var curlUserAgent = require('./restify-plugins/curl-user-agent');
var interceptors = require('./interceptors');

var jobs = require('./endpoints/jobs');
var metadata = require('./endpoints/metadata');
var ping = require('./endpoints/ping');
var roleTags = require('./endpoints/role-tags');
var statuses = require('./endpoints/statuses');
var vms = require('./endpoints/vms');

var CNAPI = require('./apis/cnapi');
var IMGAPI = require('./apis/imgapi');
var MORAY = require('./apis/moray');
var NAPI = require('./apis/napi');
var PAPI = require('./apis/papi');
var WFAPI = require('./apis/wfapi');

var validations = require('./common/validation');

var EventEmitter = require('events').EventEmitter;

var os = require('os');
var crypto = require('crypto');
var http = require('http');
var https = require('https');

var request_seq_id = 0;


/*
 * VMAPI constructor
 */
function VMAPI(options) {
    this.validateConfig(options);
    this.config = options;

    EventEmitter.call(this);

    http.globalAgent.maxSockets = this.config.maxSockets || 100;
    https.globalAgent.maxSockets = this.config.maxSockets || 100;

    validations.init(options);

    this._initApis();
}

util.inherits(VMAPI, EventEmitter);



/*
 * Validates that the minimum configuration values are present
 */
VMAPI.prototype.validateConfig = function (options) {
    assert.object(options, 'VMAPI configuration');
    assert.object(options.api, 'VMAPI config.api');

    // WFAPI
    assert.object(options.wfapi, 'VMAPI config.wfapi');
    assert.string(options.wfapi.url, 'VMAPI config.wfapi.url');
    assert.arrayOfString(options.wfapi.workflows,
        'VMAPI config.wfapi.workflows');

    // CNAPI
    assert.object(options.cnapi, 'VMAPI config.cnapi');
    assert.string(options.cnapi.url, 'VMAPI config.cnapi.url');

    // IMGAPI
    assert.object(options.imgapi, 'VMAPI config.imgapi');
    assert.string(options.imgapi.url, 'VMAPI config.imgapi.url');

    // NAPI
    assert.object(options.napi, 'VMAPI config.napi');
    assert.string(options.napi.url, 'VMAPI config.napi.url');

    // PAPI
    assert.object(options.papi, 'VMAPI config.papi');
    assert.string(options.papi.url, 'VMAPI config.papi.url');

    // Moray
    assert.object(options.moray, 'Moray config.host');
    assert.string(options.moray.host, 'Moray config.moray.host');
    assert.finite(options.moray.port, 'Moray config.moray.port');

    // Changefeed
    assert.object(options.changefeed,
        'Changefeed config.changefeed');
    assert.object(options.changefeed.moray,
        'Changefeed config.changefeed.moray');
    assert.string(options.changefeed.moray.bucketName,
        'Changefeed config.changefeed.moray.bucketName');
    assert.string(options.changefeed.moray.host,
        'Changefeed config.changefeed.moray.host');
    assert.finite(options.changefeed.moray.port,
        'Changefeed config.changefeed.moray.port');
    assert.finite(options.changefeed.maxAge,
        'Changefeed config.changefeed.maxAge');
    assert.arrayOfObject(options.changefeed.resources,
        'Changefeed config.Changefeed.resources');
};

function addFluentdHost(log, host) {
    var evtLogger = new EffluentLogger({
        filter: function _evtFilter(obj) { return (!!obj.evt); },
        host: host,
        log: log,
        port: 24224,
        tag: 'debug'
    });
    log.addStream({
        stream: evtLogger,
        type: 'raw'
    });
}

/*
 * Returns true if the response object "res" represents a response indicating a
 * successful HTTP request.
 */
function responseIndicatesSuccess(res) {
    assert.object(res, 'res');
    assert.finite(res.statusCode, 'res.statusCode');

    // Any 20X HTTP status code is considered to represent a successful request.
    return Math.floor(res.statusCode / 100) === 2;
}

/*
 * VMAPI API objects initialization code
 */
VMAPI.prototype._initApis = function () {
    var config = this.config;
    config.api.url = 'http://' + this.serverIp();

    // Init logger

    var log = this.log = new Logger({
        name: 'vmapi',
        level: config.logLevel,
        serializers: restify.bunyan.serializers
    });

    // EXPERIMENTAL
    if (config.fluentd_host) {
        addFluentdHost(log, config.fluentd_host);
    }

    // Init VMAPI server

    this.server = restify.createServer({
        name: 'VMAPI',
        log: log.child({ component: 'api' }, true),
        version: config.version,
        serverName: 'SmartDataCenter',
        formatters: {
            'application/json': formatJSON,
            'text/plain': formatJSON,
            'application/octet-stream': formatJSON,
            'application/x-json-stream': formatJSON,
            '*/*': formatJSON }
    });

    // This allows VMAPI to respond to HEAD requests sent by curl with proper
    // headers and prevents/fixes https://smartos.org/bugview/ZAPI-220.
    this.server.pre(curlUserAgent());

    this.server.on('after', function (req, res, route, err) {
        if (req.path() === '/ping') {
            return;
        }

        var method = req.method;

        var requestSuccessful = responseIndicatesSuccess(res);
        // For debugging purposes, include the response's body in the audit log
        // by default.
        var includeBodyInAuditLog = true;
        if (requestSuccessful) {
            // When the request is succesful, include the body of the response
            // in the audit log, unless in the following cases:
            //
            // 1. A GET request: the response's body is not particularly
            // interesting and is usually big.
            //
            // 2. A HEAD request: even if a body is set in this case, it's only
            // so that Content-Length and Content-MD5 response headers are
            // properly set in the custom JSON restify formatter according to
            // RFC 2616. Having it in the audit log is not relevant since it's
            // actually not sent to the client sending the request.
            //
            // 3. A PutVms request: the response's body would be equivalent to
            // the request's data and is usually big.
            if (method === 'GET' || method === 'HEAD' ||
                (route && route.name === 'putvms')) {
                includeBodyInAuditLog = false;
            }
        }

        restify.auditLogger({
            log: req.log.child({ route: route && route.name }, true),
            body: includeBodyInAuditLog
        })(req, res, route, err);
    });

    this.server.on('uncaughtException', function (req, res, route, error) {
        req.log.info({
            err: error,
            url: req.url,
            params: req.params
        });

        res.send(new restify.InternalError('Internal Server Error'));
    });

    config.napi.log = log.child({ component: 'napi' }, true);
    config.cnapi.log = log.child({ component: 'cnapi' }, true);
    config.wfapi.log = log.child({ component: 'wfapi' }, true);
    config.moray.log = log.child({ component: 'moray' }, true);
    config.changefeed.log = log.child({ component: 'changefeed' }, true);

    // Init Moray

    this.moray = new MORAY(config.moray);

    // Add restify server to changefeed config so that it can add routes
    config.changefeed.restifyServer = this.server;

    // Init APIs

    this.cnapi = new CNAPI(config.cnapi);
    this.imgapi = new IMGAPI(config.imgapi);
    this.napi = new NAPI(config.napi);
    this.papi = new PAPI(config.papi);
    this.wfapi = new WFAPI(config.wfapi);

    // Init Server middleware

    this.setMiddleware();
    this.setStaticRoutes();
    this.setRoutes();
};



/*
 * Starts each of its services in order
 */
VMAPI.prototype.init = function () {
    var self = this;

    self.moray.connect();
    self.wfapi.connect();

    self.publisher = changefeed.createPublisher(self.config.changefeed);
    self.publisher.once('moray-ready', function __listen() {
        self.listen(function () {
            self.publisher.start();
            self.emit('ready');
        });
    });
};



/*
 * Sets custom middlewares to use for the API
 */
VMAPI.prototype.setMiddleware = function () {
    var self = this;
    var server = this.server;
    server.use(function (req, res, next) {
        res.on('header', function onHeader() {
            var now = Date.now();
            res.header('Date', new Date());
            res.header('Server', server.name);
            res.header('x-request-id', req.getId());
            var t = now - req.time();
            res.header('x-response-time', t);
            res.header('x-server-name', os.hostname());
        });
        req._config = self.config;
        next();
    });

    server.use(restify.requestLogger());

    var EVT_SKIP_ROUTES = {
        'ping': true,
        'changefeeds': true,
        'changefeeds_stats': true
    };
    server.use(function (req, res, next) {
        req.trace = trace_event.createBunyanTracer({
            log: req.log
        });
        if (req.route && !EVT_SKIP_ROUTES[req.route.name]) {
            request_seq_id = (request_seq_id + 1) % 1000;
            req.trace.seq_id = (req.time() * 1000) + request_seq_id;
            req.trace.begin({name: req.route.name, req_seq: req.trace.seq_id});
        }
        next();
    });
    server.on('after', function (req, res, route, err) {
        if (route && !EVT_SKIP_ROUTES[route.name]) {
            req.trace.end({name: route.name, req_seq: req.trace.seq_id});
        }
    });

    server.use(restify.acceptParser(server.acceptable));
    server.use(restify.bodyParser());
    server.use(restify.dateParser());
    server.use(restify.queryParser({allowDots: false, plainObjects: false}));
};



/*
 * Sets all routes for static content
 */
VMAPI.prototype.setStaticRoutes = function () {
    return;
};



/*
 * Sets all routes for the VMAPI server
 */
VMAPI.prototype.setRoutes = function () {
    var vmapi = this;

    vmapi.server.use(function _setApp(req, res, next) {
        req.app = vmapi;
        return next();
    });

    vms.mount(this.server);
    jobs.mount(this.server);
    roleTags.mount(this.server);
    metadata.mount(this.server);
    statuses.mount(this.server);
    ping.mount(this.server);
};



/*
 * Gets the server IP address for use by WFAPI on ping backs
 */
VMAPI.prototype.serverIp = function () {
    var interfaces = os.networkInterfaces();

    var ifs = interfaces['net0'] || interfaces['en1'] || interfaces['en0'];
    var ip;

    for (var i = 0; i < ifs.length; i++) {
        if (ifs[i].family === 'IPv4') {
            ip = ifs[i].address;
            break;
        }
    }

    return ip;
};



/*
 * Starts listening on the port given specified by config.api.port. Takes a
 * callback as an argument. The callback is called with no arguments
 */
VMAPI.prototype.listen = function (callback) {
    var self = this;

    this.server.listen(this.config.api.port || 80, '0.0.0.0', function () {
        self.log.info({ url: self.server.url },
                      '%s listening', self.server.name);

        if (callback) {
            callback();
        }

        return;
    });
};



/*
 * Force JSON for all accept headers
 */
function formatJSON(req, res, body, callback) {
    var formattedJson;

    if (body instanceof Error) {
        // snoop for RestError or HttpError, but don't rely on
        // instanceof
        res.statusCode = body.statusCode || 500;

        if (body.body) {
            body = body.body;
        } else {
            body = { message: body.message };
        }
    } else if (Buffer.isBuffer(body)) {
        body = body.toString('base64');
    }

    var data = JSON.stringify(body);
    var md5 = crypto.createHash('md5').update(data).digest('base64');

    res.setHeader('Content-Length', Buffer.byteLength(data));
    res.setHeader('Content-MD5', md5);
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'HEAD') {
        // In case of a successful response to a HEAD request, the formatter is
        // used to properly set the Content-Length and Content-MD5 headers, but
        // no data should actually be sent as part of the response's body. This
        // is all according to RFC 2616.
        formattedJson = '';
    } else {
        formattedJson = data;
    }

    callback(null, formattedJson);
}


module.exports = VMAPI;
