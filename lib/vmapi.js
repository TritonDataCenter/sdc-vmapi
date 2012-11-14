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

var NAPI = require('./apis/napi');
var CNAPI = require('./apis/cnapi');
var WFAPI = require('./apis/wfapi');
var MORAY = require('./apis/moray');
var Cache = require('./cache');

var EventEmitter = require('events').EventEmitter;

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
}

util.inherits(VMAPI, EventEmitter);



/*
 * Validates that the minimum configuration values are present
 */
VMAPI.prototype.validateConfig = function (options) {
    assert.object(options, 'VMAPI configuration');
    assert.object(options.api, 'VMAPI config.api');

    // AMQP
    assert.object(options.amqp, 'VMAPI config.amqp');
    assert.string(options.amqp.host, 'VMAPI config.amqp.host');

    // Redis
    assert.object(options.redis, 'VMAPI config.redis');
    assert.string(options.redis.host, 'VMAPI config.redis.host');

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
    assert.string(options.napi.username, 'VMAPI config.napi.username');
    assert.string(options.napi.password, 'VMAPI config.napi.password');

    // Moray
    assert.object(options.moray, 'Moray config.host');
    assert.string(options.moray.host, 'Moray config.moray.host');
    assert.number(options.moray.port, 'Moray config.moray.port');
};


/*
 * VMAPI API objects initialization code
 */
VMAPI.prototype._initApis = function () {
    var self = this;
    var config = this.config;

    config.api.url = 'http://' + this.serverIp();


    // Init logger

    var log = this.log = new Logger({
      name: 'vmapi',
      level: config.logLevel,
      serializers: {
          err: Logger.stdSerializers.err,
          req: Logger.stdSerializers.req,
          res: restify.bunyan.serializers.res
      }
    });


    // Init VMAPI server

    this.server = restify.createServer({
        name: 'VMs API',
        log: log,
        version: config.version,
        serverName: 'SmartDataCenter',
        formatters: {
            'application/json': formatJSON,
            'text/plain': formatJSON,
            'application/octet-stream': formatJSON,
            'application/x-json-stream': formatJSON,
            '*/*': formatJSON }
    });

    this.server.on('after', restify.auditLogger({log: log, body: true}));

    this.server.on('uncaughtException', function (req, res, route, error) {
        req.log.info({
            err: error,
            url: req.url,
            params: req.params
        });

        res.send(new restify.InternalError('Internal Server Error'));
    });

    config.amqp.log = log;
    config.napi.log = log;
    config.cnapi.log = log;
    config.wfapi.log = log;
    config.redis.log = log;
    config.moray.log = log;

    // Init Redis Cache

    this.cache = new Cache(config.redis);

    // Init Moray

    this.moray = new MORAY(config.moray);

    // Init CNAPI and heartbeater

    this.cnapi = new CNAPI(config.cnapi);
    this.heartbeater = new Heartbeater(config.amqp);

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

    var functions = [
        this.moray.connect.bind(this.moray),
        this.cache.connect.bind(this.cache),
        this.heartbeater.connect.bind(this.heartbeater),
        this.wfapi.connect.bind(this.wfapi)
    ];

    function afterInit (err, results){
        if (err) {
            throw (err);
        } else {
            self.emit('ready');
        }
    }

    async.series(functions, afterInit);
};



/*
 * Sets custom middlewares to use for the API
 */
VMAPI.prototype.setMiddleware = function () {
    this.server.use(restify.acceptParser(this.server.acceptable));
    this.server.use(restify.bodyParser());
    this.server.use(restify.dateParser());
    this.server.use(restify.queryParser());
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
        req.moray = vmapi.moray;
        req.wfapi = vmapi.wfapi;
        req.cnapi = vmapi.cnapi;
        req.cache = vmapi.cache;
        req.config = vmapi.config;

        return next();
    }

    var before = [
        addProxies,
        interceptors.checkWfapi,
        interceptors.checkMoray,
        interceptors.loadVm
    ];

    vms.mount(this.server, before);
    jobs.mount(this.server, before);
    metadata.mount(this.server, before);
    statuses.mount(this.server, before);
};



/*
 * Process each heartbeat. Calls back the heartbeater with the VMAPI instance
 */
VMAPI.prototype.onHeartbeats = function (serverUuid, hbs, missing) {
    this.heartbeater.processHeartbeats(this, serverUuid, hbs, missing);
};



/*
 * Gets the server IP address for use by WFAPI on ping backs
 */
VMAPI.prototype.serverIp = function () {
    var os = require('os');
    var interfaces = os.networkInterfaces();

    var ifs = interfaces['net0'] || interfaces['en1'];
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

    this.heartbeater.on('heartbeat', self.onHeartbeats.bind(self));

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
