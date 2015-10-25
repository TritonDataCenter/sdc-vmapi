/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * A brief overview of this source file: what is its purpose.
 */

var restify = require('restify');
var assert = require('assert-plus');
var common = require('./common');
var errors = require('./errors');


/*
 * Checks that WFAPI workflows are loaded.
 */
exports.checkWfapi = function checkWfapi(req, res, next) {
    // POST, PUT and DELETE use workflows
    if (req.method == 'GET') {
        next();
        return;
    }

    if (!req.app.wfapi.connected) {
        return next(new restify.ServiceUnavailableError('Workflow API is ' +
            'unavailable'));
    }
    return next();
};



/*
 * Loads a vm from moray. Gets set as req.vm for later usage.
 */
exports.loadVm = function loadVm(req, res, next) {
    var skipRoutes = ['listvms', 'createvm'];

    if (!req.params.uuid || skipRoutes.indexOf(req.route.name) !== -1) {
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

exports.checkVMNotDestroying = function checkVMNotDestroying(req, res, next) {
    assert.object(req.vm, 'req.vm must be an object');

    if (req.vm.transitive_state === 'destroying') {
        return next(new errors.VMBeingDestroyedError());
    } else {
        return next();
    }
};
