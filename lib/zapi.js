/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Main entry-point for the Zones API.
 */

var restify = require('restify');
var Logger = require('bunyan');

var Heartbeater = require('./heartbeater');
var interceptors = require('./interceptors');
var machines = require('./machines');
var tags = require('./tags');

var Cache = require('expiring-lru-cache');

var UFDS = require('./ufds');
var CNAPI = require('./cnapi');

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

  this.server.on('uncaughtException', function (req, res, route, error) {
    req.log.info({
      err: error,
      url: req.url,
      params: req.params
    });

    res.send(new restify.InternalError('Internal Server Error'));
  });

  config.amqp.log = log;
  config.cnapi.log = log;
  config.ufds.logLevel = config.logLevel;


  // Init UFDS

  var ufds = this.ufds = new UFDS(config.ufds);

  ufds.on('ready', function () {
    self.emit('ready');
  });

  ufds.on('error', function (err) {
    self.emit('error', err);
  });


  // Init CNAPI and heartbeater

  var cnapi = this.cnapi = new CNAPI(config.cnapi);
  var heartbeater = this.heartbeater = new Heartbeater(config.amqp);

  this.cache = new Cache({
    size: 100,
    expiry: 3600 * 1000,
    log: log,
    name: 'machinesCache'
  });


  // Init Server middleware

  this.setMiddleware();
  this.setStaticRoutes();
  this.setRoutes();
}



/*
 * Sets custom middlewares to use for the API
 */
ZAPI.prototype.setMiddleware = function () {
  this.server.use(restify.acceptParser(this.server.acceptable));
  this.server.use(restify.authorizationParser());
  this.server.use(restify.bodyParser());
  this.server.use(restify.queryParser());
}



/*
 * Sets all routes for static content
 */
ZAPI.prototype.setStaticRoutes = function () {

  // TODO: static serve the docs, favicon, etc.
  //  waiting on https://github.com/mcavage/node-restify/issues/56 for this.
  this.server.get('/favicon.ico', function (req, res, next) {
      filed(__dirname + '/docs/media/img/favicon.ico').pipe(res);
      next();
  });
}



/*
 * Sets all routes for the ZAPI server
 */
ZAPI.prototype.setRoutes = function () {
  var config = this.config;
  var ufds = this.ufds;

  function addProxies(req, res, next) {
    req.config = config;
    req.ufds = ufds;

    return next();
  }

  var before = [
    addProxies,
    interceptors.authenticate,
    interceptors.loadMachine
  ];

  machines.mount(this.server, before);
  tags.mount(this.server, before);
}



/*
 * Process each heartbeat. For each heartbeat we need to check if the machine
 * exists and create it on UFDS if they don't
 *
 * Sample heartbeat:
 *    ID   zonename  status
 *   [ 0, 'global', 'running', '/', '', 'liveimg', 'shared', '0'
 */
ZAPI.prototype.onHeartbeats = function (serverUuid, hbs) {
  var self = this;

  for (var i = 0; i < hbs.length; i++) {
    var hb = hbs[i];
    var uuid = hb[1];
    var status = hb[2];

    if (uuid != 'global' && !self.cache.get(uuid)) {
      self.cache.set(uuid, status);

      self.cnapi.getMachine(serverUuid, uuid, function (err, machine) {
        if (err)
          self.log.error('Error talking to CNAPI', err);
        else
          self.addMachine(machine);
      });
    }
  }
}



ZAPI.prototype.addMachine = function (machine) {
  var ufds = this.ufds;
  var log = this.log;

  var params = {
    uuid: machine.zonename,
    owner_uuid: machine.owner_uuid
  }

  ufds.getMachine(params, function (err, m) {
    if (err)
      log.error('Error getting machine info from UFDS', err);

    if (!m) {
      ufds.addMachine(machine, function (err) {
        if (err)
          log.error('Could not create machine on UFDS', err);
        else
          log.debug('Added machine ' + machine.zonename + ' to UFDS');
      });
    }
  });
}



/*
 * Starts listening on the port given specified by config.api.port. Takes a
 * callback as an argument. The callback is called with no arguments
 */
ZAPI.prototype.listen = function (callback) {
  var self = this;

  this.heartbeater.on('heartbeat', self.onHeartbeats.bind(self));

  this.server.listen(this.config.api.port, '0.0.0.0', function () {
    self.log.info( { url: self.server.url }, '%s listening', self.server.name);

    if (callback)
      return callback();
  });
}


module.exports = ZAPI;
