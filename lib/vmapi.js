/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Main entry-point for the VMs API.
 */

var restify = require('restify');
var Logger = require('bunyan');
var util = require('util');
var assert = require('assert-plus');
var async = require('async');

var common = require('./common');

var Heartbeater = require('./heartbeater');
var interceptors = require('./interceptors');

var vms = require('./endpoints/vms');
var metadata = require('./endpoints/metadata');
var jobs = require('./endpoints/jobs');
var statuses = require('./endpoints/statuses');
var ping = require('./endpoints/ping');

var NAPI = require('./apis/napi');
var CNAPI = require('./apis/cnapi');
var WFAPI = require('./apis/wfapi');
var MORAY = require('./apis/moray');
var Cache = require('./cache');

var EventEmitter = require('events').EventEmitter;

var os = require('os');
var crypto = require('crypto');
var http = require('http');
var https = require('https');



/*
 * VMAPI constructor
 */
function VMAPI(options) {
    this.validateConfig(options);
    this.config = options;

    EventEmitter.call(this);

    http.globalAgent.maxSockets = this.config.maxSockets || 100;
    https.globalAgent.maxSockets = this.config.maxSockets || 100;

    this._initApis();
    this.statuses = {
        INITIALIZING: 'initializing',
        POPULATING: 'populating database',
        NOT_CONNECTED: 'some services are not connected',
        OK: 'OK'
    };
    this.status = this.statuses.INITIALIZING;
}

util.inherits(VMAPI, EventEmitter);



/*
 * Validates that the minimum configuration values are present
 */
VMAPI.prototype.validateConfig = function (options) {
    assert.object(options, 'VMAPI configuration');
    assert.object(options.api, 'VMAPI config.api');

    // AMQP - deprecated
    assert.optionalObject(options.amqp, 'VMAPI config.amqp');

    // Heartbeater - new config
    assert.optionalObject(options.heartbeater, 'config.heartbeater');
    assert.optionalString(options.heartbeater.host, 'config.heartbeater.host');

    // Cache
    assert.object(options.cache, 'VMAPI config.cache');
    assert.string(options.cache.type, 'VMAPI config.cache.type');
    if (options.cache.type === 'redis') {
        assert.string(options.cache.host, 'VMAPI config.cache.host');
    }

    // WFAPI
    assert.object(options.wfapi, 'VMAPI config.wfapi');
    assert.string(options.wfapi.url, 'VMAPI config.wfapi.url');
    assert.arrayOfString(options.wfapi.workflows,
        'VMAPI config.wfapi.workflows');

    // CNAPI
    assert.object(options.cnapi, 'VMAPI config.cnapi');
    assert.string(options.cnapi.url, 'VMAPI config.cnapi.url');

    // NAPI
    assert.object(options.napi, 'VMAPI config.napi');
    assert.string(options.napi.url, 'VMAPI config.napi.url');

    // Moray
    assert.object(options.moray, 'Moray config.host');
    assert.string(options.moray.host, 'Moray config.moray.host');
    assert.number(options.moray.port, 'Moray config.moray.port');
};


/*
 * VMAPI API objects initialization code
 */
VMAPI.prototype._initApis = function () {
    var config = this.config;
    config.api.url = 'http://' + this.serverIp();
    // In case config file is not updated and still using legacy 'amqp'
    if (!config.heartbeater) config.heartbeater = {};


    // Init logger

    var log = this.log = new Logger({
        name: 'vmapi',
        level: config.logLevel,
        serializers: restify.bunyan.serializers
    });


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

    this.server.on('after', function (req, res, route, err) {
        if (req.path() === '/ping') {
            return;
        }

        // Successful GET res bodies are uninteresting and *big*.
        var method = req.method;
        var body = !(method === 'GET' && Math.floor(res.statusCode/100) === 2);

        restify.auditLogger({
            log: req.log.child({ route: route && route.name }, true),
            body: body
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

    config.heartbeater.log = log.child({ component: 'heartbeater' }, true);
    config.napi.log = log.child({ component: 'napi' }, true);
    config.cnapi.log = log.child({ component: 'cnapi' }, true);
    config.wfapi.log = log.child({ component: 'wfapi' }, true);
    config.cache.log = log.child({ component: 'hb-cache' }, true);
    config.moray.log = log.child({ component: 'moray' }, true);

    // Init Moray

    this.moray = new MORAY(config.moray);

    // Init Heartbeat Cache

    var cacheOpts = config.cache;
    // Additional setup so we reuse the moray connection
    if (cacheOpts.type === 'moray') {
        cacheOpts.client = this.moray;
    }
    this.cache = new Cache[cacheOpts.type](cacheOpts);

    // Init CNAPI and heartbeater

    this.cnapi = new CNAPI(config.cnapi);
    var hbConfig = config.heartbeater;
    // Legacy
    if (config.amqp && config.amqp.host) {
        hbConfig.host = config.amqp.host;
        log.warn('config.amqp is deprecated. You should put your AMQP config ' +
            'details under config.heartbeater. (Found config.amqp.host)');
    }
    if (config.amqp && config.amqp.queue) {
        hbConfig.queue = config.amqp.queue;
        log.warn('config.amqp is deprecated. You should put your AMQP config ' +
            'details under config.heartbeater. (Found config.amqp.queue)');
    }
    if (config.heartbeatQueueSize) {
        hbConfig.concurrency = config.heartbeatQueueSize;
        log.warn('config.heartbeatQueueSize is deprecated. You should specify' +
            ' heartbeatQueueSize as config.heartbeater.concurrency');
    }
    this.heartbeater = new Heartbeater(config.heartbeater);

    // Init WAPI and heartbeater

    this.wfapi = new WFAPI(config.wfapi);

    // Init NAPI

    this.napi = new NAPI(config.napi);

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
    self.cache.connect();
    self.wfapi.connect();
    self.heartbeater.connect();
    self.heartbeater.setListener(self);

    self.listen(function () {
        self.emit('ready');
    });
};



/*
 * Sets custom middlewares to use for the API
 */
VMAPI.prototype.setMiddleware = function () {
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
        next();
    });

    server.use(restify.requestLogger());
    server.use(restify.acceptParser(server.acceptable));
    server.use(restify.bodyParser());
    server.use(restify.dateParser());
    server.use(restify.queryParser());
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

    function addProxies(req, res, next) {
        req.app = vmapi;
        return next();
    }

    var before = [
        addProxies,
        interceptors.checkWfapi,
        interceptors.loadVm
    ];

    vms.mount(this.server, before);
    jobs.mount(this.server, before);
    metadata.mount(this.server, before);
    statuses.mount(this.server, before);
    ping.mount(this.server, [ addProxies ]);
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
function formatJSON(req, res, body) {
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

    return (data);
}


module.exports = VMAPI;
