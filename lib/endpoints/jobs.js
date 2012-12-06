/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var restify = require('restify');
var assert = require('assert');

var common = require('../common');



/*
 * GET /jobs/:uuid
 */
function getJob(req, res, next) {
    req.log.trace('GetJob start');

    req.wfapi.getJob(req.params.job_uuid, function (err, job) {
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

    req.wfapi.listJobs(req.params, function (err, jobs) {
        if (err)
            return next(err);

        res.send(jobs);
        return next();
    });
}



/*
 * GET /job_results
 */
function jobResults(req, res, next) {
    req.log.trace('JobResults start');

    req.log.info('Received post back job results', req.params);

    // For now, ignore everything unless it is a failed provision
    if (req.params.execution && req.params.execution == 'failed' &&
        req.params.vm_uuid) {

        req.params['state'] = 'failed';
        req.params['zone_state'] = 'failed';

        var vm = common.translateVm(req.params, false);
        req.cache.setVm(req.params.vm_uuid, vm, function (err) {
            if (err) {
                return next(err);
            } else {
                req.log.info('Set VM %s state as failed', req.params.vm_uuid);
                res.send(200);
                return next();
            }
        });

    } else {
        res.send(200);
        return next();
    }
}



/*
 * Mounts job actions as server routes
 */
function mount(server, before) {
    server.get({ path: '/vms/:uuid/jobs', name: 'ListVmJobs' },
                  before, listJobs);
    server.get({ path: '/jobs', name: 'ListJobs' }, before, listJobs);
    server.get({ path: '/jobs/:job_uuid', name: 'GetJob' }, before, getJob);

    // Post back URL for provision job results
    server.post({ path: '/job_results', name: 'JobResults' },
                  before, jobResults);
}


// --- Exports

module.exports = {
    mount: mount
};
