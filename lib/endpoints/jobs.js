/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var restify = require('restify');
var ldap = require('ldapjs');
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

        res.send(common.translateJob(job));
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
 * Mounts job actions as server routes
 */
function mount(server, before) {
    server.get({ path: '/vms/:uuid/jobs', name: 'ListVmJobs' }, before, listJobs);
    server.get({ path: '/jobs', name: 'ListJobs' }, before, listJobs);
    server.get({ path: '/jobs/:job_uuid', name: 'GetJob' }, before, getJob);
}


// --- Exports

module.exports = {
    mount: mount
};