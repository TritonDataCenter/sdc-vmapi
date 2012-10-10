/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var restify = require('restify');
var common = require('./common');


module.exports = {


    /*
     * Checks that WFAPI workflows are loaded.
     */
    checkWfapi: function (req, res, next) {
        // POST, PUT and DELETE use workflows
        if (req.method == 'GET') {
            next();
            return;
        }

        if (req.wfapi.connected) {
            next();
        } else {
            next(
              new restify.InternalError('WFAPI workflows are not loaded'));
        }
    },


    /*
     * Checks that UFDS is up. /vms is the only route that talks to UFDS
     */
    checkUfds: function (req, res, next) {
        if (req.path != '/vms') {
            next();
            return;
        }

        if (req.ufds.connected) {
            next();
        } else {
            next(
              new restify.InternalError('UFDS Server is Down'));
        }
    },



    /*
     * Checks that the redis cache is up. VM routes are the only ones
     * that talk to redis
     */
    checkCache: function (req, res, next) {
        // If the route doesn't have a UUID then it's not a vm based route
        if (!req.params.uuid) {
            next();
            return;
        }

        // Allow listVms to take care of this
        if (req.path == '/vms') {
            next();
            return;
        }

        if (req.cache.connected()) {
            next();
        } else {
            next(
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
            next();
            return;
        }

        // Allow listVms to take care of this
        if (req.path == '/vms') {
            next();
            return;
        }

        function onUfdsGetVm(err, vm) {
            if (err) {
                next(err);
                return;
            }

            if (!vm) {
                next(
                  new restify.ResourceNotFoundError('VM not found'));
            } else {
                req.log.info('Cache MISS for VM %s', req.params.uuid);
                req.vm = common.translateVm(vm, true);
                next();
            }
        }

        function onGetVm(cacheErr, cached) {
            if (cacheErr) {
                next(cacheErr);
                return;
            }

            if (cached) {
                cached = common.translateVm(cached, true);
                try {
                    common.validOwner(cached, req.params);
                } catch (e) {
                    next(e);
                    return;
                }

                req.vm = cached;
                req.log.info('Cache HIT for VM %s', cached.uuid);
                next();

            } else {
                req.ufds.getVm(req.params, onUfdsGetVm);
            }
        }

        req.cache.getVm(req.params.uuid, onGetVm);
    }

};
