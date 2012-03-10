/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var restify = require('restify');

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
  }

}