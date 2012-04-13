/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var restify = require('restify');
var ldap = require('ldapjs');
var assert = require('assert');

var common = require('./common');


/*
 * GET /jobs
 */
function listJobs(req, res, next) {
    req.log.trace('ListJobs start');

    // req.ufds.listTags(req.machine, function (err, tags) {
    //   if (err)
    //     return next(err);
    //
    //   res.send(200, tags);
    //   return next();
    // });
}



/*
 * GET /jobs/:uuid
 */
function getJob(req, res, next) {
    req.log.trace('GetJob start');

    req.wfapi.getJob(req.params.uuid, function (err, job) {
        if (err)
            return next(err);

        res.send(common.translateJob(job));
        return next();
    });
}



/*
 * Mounts job actions as server routes
 */
function mount(server, before) {
    server.get({ path: '/jobs', name: 'ListJobs' }, before, listJobs);
    server.get({ path: '/jobs/:uuid', name: 'GetJob' }, before, getJob);
}


// --- Exports

module.exports = {
    mount: mount
};