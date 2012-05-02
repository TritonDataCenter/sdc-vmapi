/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var restify = require('restify');
var common = require('./common');


module.exports = {

    /*
     * HTTP Basic Authentication handler
     */
    authenticate: function (req, res, next) {
        req.log.debug('authenticate: authorization=%o', req.authorization);

        if (!req.authorization || !req.authorization.scheme ||
            !req.authorization.basic) {
            return next(
                new restify.InvalidCredentialsError(401,
                    'Authentication Required'));
        }

        var user = req.authorization.basic.username;
        var pass = req.authorization.basic.password;

        if (user != req.config.api.username && pass != req.config.api.password)
            return next(
              new restify.InvalidCredentialsError(401, 'Invalid Credentials'));

        return next();
    },



    /*
     * Loads a machine from UFDS. Gets set as req.machine for later usage.
     * Before calling UFDS we call our local cache.
     */
    loadMachine: function (req, res, next) {
        // If the route doesn't have a UUID then it's not a machine based route
        if (!req.params.uuid)
            return next();

        var cached = req.cache.get(req.params.uuid);

        if (cached) {
            req.machine = cached.machine;
            return next();
        } else {

            return req.ufds.getMachine(req.params, function (err, machine) {
                if (err)
                    return next(err);

                if (!machine) {
                    return next(
                      new restify.ResourceNotFoundError('Machine not found'));
                } else {
                    req.machine = machine;
                }

                return next();
            });
        }
    }

};
