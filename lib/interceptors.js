/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var restify = require('restify');
var common = require('./common');



/*
 * Checks that WFAPI workflows are loaded.
 */
exports.checkWfapi = function (req, res, next) {
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
};


/*
 * Checks that Moray is up.
 */
exports.checkMoray = function (req, res, next) {
    if (req.moray.connected) {
        next();
    } else {
        next(
          new restify.InternalError('Moray server is down'));
    }
};



/*
 * Loads a vm from moray. Gets set as req.vm for later usage.
 */
exports.loadVm = function (req, res, next) {
    // If the route doesn't have a UUID then it's not a vm based route
    if (!req.params.uuid) {
        next();
        return;
    }

    // Allow listVms to take care of this
    if (req.path() == '/vms') {
        next();
        return;
    }

    req.moray.getVm(req.params, onGetVm);

    function onGetVm(err, vm) {
        if (err) {
            next(err);
            return;
        }

        // If vm is not in moray it might be in the 'provisioning' cache
        if (vm) {
            req.vm = common.translateVm(vm, true);
            next();
        } else {
            req.cache.getVm(req.params.uuid, onCacheGetVm);
        }
    }

    function onCacheGetVm(cacheErr, cached) {
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
            next(new restify.ResourceNotFoundError('VM not found'));
        }
    }
};
