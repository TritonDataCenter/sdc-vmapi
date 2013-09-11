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
exports.checkWfapi = function checkWfapi(req, res, next) {
    // POST, PUT and DELETE use workflows
    if (req.method == 'GET') {
        next();
        return;
    }

    if (req.app.wfapi.connected) {
        next();
    } else {
        next(
        new restify.ServiceUnavailableError('WFAPI workflows are not loaded'));
    }
};


/*
 * Checks that Moray is up.
 */
exports.checkMoray = function checkMoray(req, res, next) {
    if (req.app.moray.connected) {
        next();
    } else {
        // Never trust
        req.app.moray.ping(function (err) {
            if (err) {
                req.log.error(err, 'Error while pinging moray');
                next(new restify.ServiceUnavailableError(err,
                    'Moray server is down'));
            } else {
                req.app.moray.connected = true;
                next();
            }
            return;
        });
    }
};



/*
 * Loads a vm from moray. Gets set as req.vm for later usage.
 */
exports.loadVm = function loadVm(req, res, next) {
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

    // Add vm_uuid record so we can trace all API requests related to this VM
    req.log = req.log.child({ vm_uuid: req.params.uuid }, true);
    req.app.moray.getVm(req.params, onGetVm);

    function onGetVm(err, vm) {
        if (err) {
            next(err);
            return;
        }

        if (vm) {
            try {
                common.validOwner(vm, req.params);
            } catch (e) {
                next(e);
                return;
            }

            req.vm = common.translateVm(vm, true);
            next();
        } else {
            next(new restify.ResourceNotFoundError('VM not found'));
        }
    }
};
