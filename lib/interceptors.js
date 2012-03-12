/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var restify = require('restify');
var common = require('./common');

var SUFFIX = 'o=smartdc';

var USERS = 'ou=users, ' + SUFFIX;
var USER_FMT = 'uuid=%s, ' + USERS;
var MACHINE_FMT = 'machineid=%s, ' + USER_FMT;

module.exports = {

  authenticate: function(req, res, next) {
    req.log.debug('authenticate: authorization=%o', req.authorization);

    if (!req.authorization || !req.authorization.scheme || !req.authorization.basic)
      return next(new restify.InvalidCredentialsError(401, "Authentication Required"));

    var user = req.authorization.basic.username;
    var pass = req.authorization.basic.password;

    if (user != req.config.api.username && pass != req.config.api.password)
      return next(new restify.InvalidCredentialsError(401, "Invalid Credentials"));

    return next();
  },



  /*
   * Loads a machine from UFDS. Gets set as req.machine for later usage
   */
  loadMachine: function(req, res, next) {
    var baseDn;
    var uuid = req.params.uuid;
    var owner_uuid = req.params.owner_uuid;

    // If the route doesn't have a UUID then it's not a machine based route
    if (!uuid)
      return next();

    if (!common.validUUID(uuid))
      return next(new restify.ConflictError('Machine UUID is not a valid UUID'));

    if (owner_uuid) {
      if (!common.validUUID(owner_uuid))
        return next(new restify.ConflictError('Owner UUID is not a valid UUID'));

      baseDn = sprintf(USER_FMT, owner_uuid);
    } else {
      baseDn = USERS;
    }

    var options = {
      scope: "sub",
      filter: "(&(objectclass=machine)(machineid=" + uuid + "))"
    };

    req.ufds.search(baseDn, options, function(err, items) {
      if (err)
        return next(err);

      if (items.length == 0)
        return next(new restify.ResourceNotFoundError('Machine not found'));
      else
        req.machine = items[0];

      return next();
    });
  }

}