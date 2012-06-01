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
        req.log.trace('authenticate: authorization=%o', req.authorization);

        if (!req.authorization || !req.authorization.scheme ||
            !req.authorization.basic) {
            return next(
                new restify.InvalidCredentialsError(401,
                    'Authentication Required'));
        }

        var user = req.authorization.basic.username;
        var pass = req.authorization.basic.password;

        if (user != req.config.api.username ||
            pass != req.config.api.password) {
            return next(
              new restify.InvalidCredentialsError(401, 'Invalid Credentials'));
        }

        return next();
    },



    /*
     * Loads a vm from UFDS. Gets set as req.vm for later usage.
     * Before calling UFDS we call our local cache.
     */
    loadVm: function (req, res, next) {
        // If the route doesn't have a UUID then it's not a vm based route
        if (!req.params.uuid)
            return next();

        var cached = req.cache.get(req.params.uuid);

        if (cached) {
            try {
                common.validOwner(cached, req.params);
            } catch (e) {
                return next(e);
            }
            req.vm = cached;
            return next();
        } else {

            return req.ufds.getVm(req.params, function (err, vm) {
                if (err)
                    return next(err);

                if (!vm) {
                    return next(
                      new restify.ResourceNotFoundError('VM not found'));
                } else {
                    req.vm = common.translateVm(vm, true);
                }

                return next();
            });
        }
    }

};
