/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


// This is not really needed, but javascriptlint will complain otherwise:
var sdcClients = require('sdc-clients');
var uuid = require('node-uuid');
var common = require('./job-common');


function setupRequest(job, cb) {
    job.endpoint = '/servers/' +
                   job.params.server_uuid + '/vms/' +
                   job.params.muuid + '/start';
    job.params.jobid = job.uuid;
    job.requestMethod = 'post';

    return cb(null, 'Request has been setup!');
}



var workflow = module.exports = {
    name: 'start-' + uuid(),
    chain: [ {
        name: 'Validate parameters',
        timeout: 30,
        retry: 1,
        body: common.validateForZoneAction
    }, {
        name: 'Setup request',
        timeout: 30,
        retry: 1,
        body: setupRequest
    }, {
        name: 'Start',
        timeout: 120,
        retry: 1,
        body: common.zoneAction
    }, {
        name: 'Poll',
        timeout: 240,
        retry: 1,
        body: common.pollTask
    }],
    timeout: 180,
    onerror: [ {
        name: 'On error',
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }]
};
