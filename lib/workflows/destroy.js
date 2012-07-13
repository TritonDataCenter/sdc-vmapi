/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


// This is not really needed, but javascriptlint will complain otherwise:
var sdcClients = require('sdc-clients');
var common = require('./job-common');

var VERSION = '7.0.0';


function setupRequest(job, cb) {
    job.endpoint = '/servers/' +
                   job.params['server_uuid'] + '/vms/' +
                   job.params['vm_uuid'] + '?jobid=' + job.uuid;
    job.params.jobid = job.uuid;
    job.requestMethod = 'del';
    job.expects = 'destroyed';

    return cb(null, 'Request has been setup!');
}



var workflow = module.exports = {
    name: 'destroy-' + VERSION,
    version: VERSION,
    chain: [ {
        name: 'common.validate_params',
        timeout: 10,
        retry: 1,
        body: common.validateForZoneAction
    }, {
        name: 'common.setup_request',
        timeout: 10,
        retry: 1,
        body: setupRequest
    }, {
        name: 'cnapi.destroy_vm',
        timeout: 10,
        retry: 1,
        body: common.zoneAction
    }, {
        name: 'cnapi.poll_task',
        timeout: 120,
        retry: 1,
        body: common.pollTask
    }, {
        name: 'vmapi.check_state',
        timeout: 60,
        retry: 1,
        body: common.checkState
    }],
    timeout: 180,
    onerror: [ {
        name: 'On error',
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }]
};
