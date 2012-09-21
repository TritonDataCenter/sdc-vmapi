/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var restify = require('restify');
var common = require('./common');


module.exports = {


    /*
     * Checks that UFDS is up. /vms is the only route that talks to UFDS
     */
    checkUfds: function(req, res, next) {
        if (req.path != '/vms')
            return next();

        if (req.ufds.connected) {
            return next();
        } else {
            return next(
              new restify.InternalError('UFDS Server is Down'));
        }
    },



    /*
     * Checks that the redis cache is up. VM routes are the only ones
     * that talk to redis
     */
    checkCache: function(req, res, next) {
        // If the route doesn't have a UUID then it's not a vm based route
        if (!req.params.uuid)
            return next();

        // Allow listVms to take care of this
        if (req.path == '/vms')
            return next();

        if (req.cache.connected()) {
            return next();
        } else {
            return next(
              new restify.InternalError('Redis Server is Down'));
        }
    },



    /*
     * Loads a vm from Cache/UFDS. Gets set as req.vm for later usage.
     * Before calling UFDS we call our local cache.
     */
    loadVm: function (req, res, next) {
        // If the route doesn't have a UUID then it's not a vm based route
        if (!req.params.uuid) {
            return next();
        }

        // Allow listVms to take care of this
        if (req.path == '/vms') {
            return next();
        }

        function onUfdsGetVm(err, vm) {
            if (err) {
                return next(err);
            }

            if (!vm) {
                return next(
                  new restify.ResourceNotFoundError('VM not found'));
            } else {
                req.log.info('Cache MISS for VM %s', req.params.uuid);
                req.vm = common.translateVm(vm, true);
            }

            return next();
        }

        function onGetVm(cacheErr, cached) {
            if (cacheErr) {
                return next(cacheErr);
            }

            if (cached) {
                cached = common.translateVm(cached, true);
                try {
                    common.validOwner(cached, req.params);
                } catch (e) {
                    return next(e);
                }

                req.vm = cached;
                req.log.info('Cache HIT for VM %s', cached.uuid);
                return next();

            } else {
                return req.ufds.getVm(req.params, onUfdsGetVm);
            }
        }

        req.cache.getVm(req.params.uuid, onGetVm);
    }

};
