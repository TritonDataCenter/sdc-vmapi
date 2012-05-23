/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Main entry-point for the Zones API.
 */

var restify = require('restify');
var Logger = require('bunyan');
var util = require('util');

var common = require('./common');

var Heartbeater = require('./heartbeater');
var interceptors = require('./interceptors');

var machines = require('./endpoints/machines');
var metadata = require('./endpoints/metadata');
var jobs = require('./endpoints/jobs');

var Cache = require('expiring-lru-cache');

var UFDS = require('./apis/ufds');
var NAPI = require('./apis/napi');
var CNAPI = require('./apis/cnapi');
var WFAPI = require('./apis/wfapi');

var EventEmitter = require('events').EventEmitter;



/*
 * ZAPI constructor
 */
function ZAPI(options) {
    EventEmitter.call(this);
    this.config = options;
}

util.inherits(ZAPI, EventEmitter);



/*
 * ZAPI init code. Will throw exception when config is bad
 */
ZAPI.prototype.init = function () {
    var self = this;
    var config = this.config;


    // Init logger

    var log = this.log = new Logger({
      name: 'zapi',
      level: config.logLevel,
      serializers: {
          err: Logger.stdSerializers.err,
          req: Logger.stdSerializers.req,
          res: restify.bunyan.serializers.response
      }
    });


    // Init ZAPI server

    this.server = restify.createServer({
        name: 'Zones API',
        log: log,
        version: config.version,
        serverName: 'SmartDataCenter',
        accept: ['text/plain',
                 'application/json',
                 'text/html',
                 'image/png',
                 'text/css'],
        contentWriters: {
           'text/plain': function (obj) {
               if (!obj)
                   return '';
               if (typeof (obj) === 'string')
                   return obj;
               return JSON.stringify(obj, null, 2);
            }
        }
    });

    this.server.on('after', restify.auditLogger({
        log: log.child({component: 'audit'})
    }));

    this.server.on('uncaughtException', function (req, res, route, error) {
        req.log.info({
            err: error,
            url: req.url,
            params: req.params
        });

        res.send(new restify.InternalError('Internal Server Error'));
    });

    config.amqp.log = log;
    config.ufds.log = log;
    config.napi.log = log;
    config.cnapi.log = log;
    config.wfapi.log = log;
    // config.ufds.logLevel = config.logLevel;
    config.ufds.logLevel = 'info';


    // Init UFDS

    var ufds = this.ufds = new UFDS(config.ufds);

    ufds.on('ready', function () {
        self.emit('ready');
    });

    ufds.on('error', function (err) {
        self.emit('error', err);
    });


    // Init CNAPI and heartbeater

    this.cnapi = new CNAPI(config.cnapi);
    this.heartbeater = new Heartbeater(config.amqp);

    this.cache = new Cache({
        size: 100,
        expiry: 3600 * 1000,
        log: log,
        name: 'machinesCache'
    });


    // Init WAPI and heartbeater

    var wfapi = this.wfapi = new WFAPI(config.wfapi);
    wfapi.initWorkflows();

    // Init NAPI

    this.napi = new NAPI(config.napi);

    // Init Server middleware

    this.setMiddleware();
    this.setStaticRoutes();
    this.setRoutes();
};



/*
 * Sets custom middlewares to use for the API
 */
ZAPI.prototype.setMiddleware = function () {
    this.server.use(restify.acceptParser(this.server.acceptable));
    // this.server.use(restify.authorizationParser());
    this.server.use(restify.bodyParser());
    this.server.use(restify.queryParser());
};



/*
 * Sets all routes for static content
 */
ZAPI.prototype.setStaticRoutes = function () {
    return;
};



/*
 * Sets all routes for the ZAPI server
 */
ZAPI.prototype.setRoutes = function () {
    var config = this.config;
    var ufds = this.ufds;
    var wfapi = this.wfapi;
    var cache = this.cache;

    function addProxies(req, res, next) {
        req.config = config;
        req.ufds = ufds;
        req.wfapi = wfapi;
        req.cache = cache;

        return next();
    }

    var before = [ addProxies ];

    machines.mount(this.server, [ before, interceptors.loadMachine ]);
    metadata.mount(this.server, [ before, interceptors.loadMachine ]);
    jobs.mount(this.server, before);
};



/*
 * Process each heartbeat. For each heartbeat we need to check if the machine
 * exists and create it on UFDS if they don't
 *
 * Sample heartbeat:
 *    ID   zonename  status
 *   [ 0, 'global', 'running', '/', '', 'liveimg', 'shared', '0'
 */
ZAPI.prototype.onHeartbeats = function (serverUuid, hbs, missing) {
    var self = this;

    // Call machine_load from CNAPI and with that result call UFDS.
    // A call to UFDS will result in an add or replace
    function cnapiThenUfds(auuid) {
        self.cnapi.getMachine(serverUuid, auuid, function (err, machine) {
            if (err) {
                self.log.error('Error talking to CNAPI', err);
            } else {
                var m = common.translateMachine(machine, true);
                self.cache.set(auuid, m);
                self.ufds.addReplaceMachine(m);
                self.napi.addNics(m);
            }
        });
    }

    // * When self.cache.get returns nothing it means that we need to check on
    //   UFDS if the machine exists and either add it or replace it
    //
    // * When self.cache.get returns a machine we need to check two things:
    //   - Was this a status change only? Update machine status on UFDS
    //   - Was this a zone xml change? Replace machine on UFDS
    for (var i = 0; i < hbs.length; i++) {
        var hb = hbs[i];
        var uuid = hb[1];
        var zone_state = hb[2];
        var lastModified = new Date(hb[8]);

        if (uuid != 'global') {
            var oldMachine = self.cache.get(uuid);

            if (!oldMachine) {
                cnapiThenUfds(uuid);
            }

            if (oldMachine &&
                (oldMachine.zone_state != zone_state ||
                    new Date(oldMachine.last_modified) < lastModified)) {
                cnapiThenUfds(uuid);
            }
        }
    }

    for (var i = 0; i < missing.length; i++) {
        var oldMachine = self.cache.get(missing[i]);

        if (oldMachine) {
            self.ufds.markAsDestroyed(self.cache, oldMachine, function (err) {
                if (err) {
                    self.log.error('Error marking ' + oldMachine.uuid +
                                    ' as destroyed on UFDS', err);
                } else {
                    self.log.info('Machine ' + oldMachine.uuid +
                                  ' marked as destroyed on UFDS');
                }
            });
        }
    }
};



/*
 * Starts listening on the port given specified by config.api.port. Takes a
 * callback as an argument. The callback is called with no arguments
 */
ZAPI.prototype.listen = function (callback) {
    var self = this;

    this.heartbeater.on('heartbeat', self.onHeartbeats.bind(self));

    this.server.listen(this.config.api.port, '0.0.0.0', function () {
        self.log.info({ url: self.server.url },
                      '%s listening', self.server.name);

        if (callback)
            callback();
        return;
    });
};


module.exports = ZAPI;
