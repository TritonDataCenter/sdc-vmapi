/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * A brief overview of this source file: what is its purpose.
 */

var assert = require('assert-plus');
var restify = require('restify');

var common = require('./common');
var errors = require('./errors');


/*
 * Checks that WFAPI workflows are loaded.
 */
exports.checkWfapi = function checkWfapi(req, res, next) {
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
    if (!req.params.uuid) {
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

/*
 * Checks that Moray buckets have been setup successfully, otherwise calls
 * "next" with an error object as its first parameter.
 */
exports.checkMorayBucketsSetup =
    function checkMorayBucketsSetup(req, res, next) {
    assert.object(req, 'req');
    assert.object(req.app, 'req.app');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var lastMorayBucketsSetupError;
    var err;

    if (!req.app.moray.bucketsSetup()) {
        lastMorayBucketsSetupError = req.app.moray.lastBucketsSetupError();
        err = new errors.MorayBucketsNotSetupError(lastMorayBucketsSetupError);
    }

    next(err);
};
