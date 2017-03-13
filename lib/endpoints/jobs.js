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

var assert = require('assert');
var restify = require('restify');

var common = require('../common');
var interceptors = require('../interceptors');



/*
 * GET /jobs/:uuid
 */
function getJob(req, res, next) {
    req.log.trace('GetJob start');

    req.app.wfapi.getJob(req.params.job_uuid, function (err, job) {
        if (err)
            return next(err);

        res.send(job);
        return next();
    });
}



/*
 * GET /jobs
 * GET /vms/:uuid/jobs
 */
function listJobs(req, res, next) {
    req.log.trace('ListJobs start');

    if (req.vm)
        req.params.vm_uuid = req.vm.uuid;

    req.app.wfapi.listJobs(req.params, function (err, jobs) {
        if (err)
            return next(err);

        res.send(jobs);
        return next();
    });
}


/*
 * POST /job_results
 */
function postJobResults(req, res, next) {
    req.log.trace('JobResults start');
    req.log.info('Received post back job results', req.params);

    // For now, ignore everything unless it is a failed provision
    if (req.params.execution && req.params.execution == 'failed' &&
        req.params.vm_uuid) {

        req.params.state = 'failed';
        req.params.zone_state = 'failed';

        req.app.moray._getVmObject(req.params.vm_uuid, function (err, obj) {
            if (err) {
                return next(err);
            }

            var vm = common.simpleMerge(obj, req.params);
            vm = common.translateVm(vm, false);

            req.app.moray.putVm(req.params.vm_uuid, vm, obj, function (err2) {
                if (err2) {
                    return next(err2);
                } else {
                    req.log.info('Set VM %s state as failed', vm.uuid);
                    res.send(200);
                    return next();
                }
            });
        });
    } else {
        res.send(200);
        return next();
    }
}



/*
 * Mounts job actions as server routes
 */
function mount(server) {
    server.get({ path: '/vms/:uuid/jobs', name: 'ListVmJobs' },
        interceptors.loadVm,
        listJobs);
    server.get({ path: '/jobs', name: 'ListJobs' }, listJobs);
    server.get({ path: '/jobs/:job_uuid', name: 'GetJob' }, getJob);

    // Post back URL for provision job results
    server.post({ path: '/job_results', name: 'JobResults' }, postJobResults);
}


// --- Exports

module.exports = {
    mount: mount
};
