/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Main entry-point for the Zones API.
 */

var UFDS = require('sdc-clients').UFDS;
var EventEmitter = require('events').EventEmitter;
var sprintf = require('sprintf').sprintf;
var assert = require('assert');
var restify = require('restify');

var common = require('./common');

var SUFFIX = 'o=smartdc';

var USERS = 'ou=users, ' + SUFFIX;
var USER_FMT = 'uuid=%s, ' + USERS;
var MACHINE_FMT = 'machineid=%s, ' + USER_FMT;



function Ufds(options) {
  this.connection = new UFDS(options);
  this.connection.setLogLevel(options.logLevel);

  EventEmitter.call(this);

  var self = this;

  this.connection.on('ready', function () {
    self.emit('ready');
  });

  this.connection.on('error', function (err) {
    self.emit('error', err);
  });
}

util.inherits(Ufds, EventEmitter);



Ufds.prototype.search = function (base, options, callback) {
  return this.connection.search(base, options, callback);
}



Ufds.prototype.add = function (dn, entry, callback) {
  return this.connection.add(dn, entry, callback);
}



Ufds.prototype.del = function (dn, callback) {
  return this.connection.del(dn, callback);
}



Ufds.prototype.listMachines = function (params, callback) {
  var baseDn;
  var owner_uuid = params.owner_uuid;
  var filter = '';

  if (owner_uuid) {
    if (!common.validUUID(owner_uuid))
      return callback(
        new restify.ConflictError('Owner UUID is not a valid UUID'), null);

    baseDn = sprintf(USER_FMT, owner_uuid);
  } else {
    baseDn = USERS;
  }

  if (params.type)
    filter += '(type=' + params.type + ')';

  if (params.alias)
    filter += '(alias=' + params.alias + ')';

  if (params.status)
    filter += '(status=' + params.status + ')';

  if (params.ram)
    filter += '(ram=' + params.ram + ')';

  var options = {
    scope: 'sub',
    filter: '(&(objectclass=machine)' + filter + ')'
  };

  this.connection.search(baseDn, options, function (err, items) {
    if (err)
      return callback(err, null);

    var machines = [];

    for (var i = 0; i < items.length; i++)
      machines.push(common.translateMachine(items[i]));

    return callback(null, machines);
  });
}



Ufds.prototype.listTags = function (machine, callback) {
  var baseDn = machine.dn;

  var options = {
    scope: 'sub',
    filter: '(objectclass=tag)'
  };

  this.connection.search(baseDn, options, function (err, items) {
    if (err)
      return callback(err, null);

    var tags = {};

    for (var i = 0; i < items.length; i++)
      tags[items[i].key] = items[i].value;

    return callback(null, tags);
  });
}



Ufds.prototype.getTag = function (machine, key, callback) {
  var baseDn = machine.dn;

  var options = {
    scope: 'sub',
    filter: '(&(objectclass=tag)(key=' + key + '))'
  };

  this.connection.search(baseDn, options, function (err, items) {
    if (err)
      return callback(err, null);

    return callback(null, items[0]);
  });
}



Ufds.prototype.addTags = function (machine, params, callback) {
  var tags = {};

  Object.keys(params).forEach(function (key) {
    if (key != 'uuid')
      tags[key] = params[key];
  });

  var keys = Object.keys(tags);
  var added = 0;

  if (!keys.length)
    return callback(
      new restify.InvalidArgumentError('At least one tag must be provided'),
      null);


  for (var i = 0; i < keys.length; i++) {
    var baseDn = 'tagkey=' + keys[i] + ', ' + machine.dn;

    var tag = {
      key: keys[i],
      value: tags[keys[i]],
      objectclass: 'tag'
    };

    this.connection.add(baseDn, tag, function (err) {
      if (err)
        return callback(err, null);

      added++;

      if (added == keys.length) {
        return callback(null, tags);
      }
    });
  }
}



Ufds.prototype.deleteTag = function (tag, callback) {
  this.connection.del(tag.dn, function (err) {
    if (err)
      return callback(err);

    return callback(null);
  });
}



Ufds.prototype.deleteTags = function (machine, callback) {
  var self = this;
  var baseDn = machine.dn;

  var options = {
    scope: 'sub',
    filter: '(objectclass=tag)'
  };

  this.connection.search(baseDn, options, function (err, items) {
    if (err)
      return callback(err);

    if (!items.length) {
      return callback(null);
    }

    var deleted = 0;

    for (var i = 0; i < items.length; i++) {
      var tag = items[i];

      self.connection.del(tag.dn, function (err) {
        if (err)
          return callback(err);

        deleted++;

        if (deleted == items.length)
          return callback(null);
      });
    }
  });
}




module.exports = Ufds;