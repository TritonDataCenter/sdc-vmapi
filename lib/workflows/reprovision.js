/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var common = require('./job-common');
var VERSION = '7.0.0';


/*
 * Sets up a CNAPI VM action request. Take a look at common.zoneAction. Here you
 * can set parameters such as:
 * - request endpoint (usually the VM endpoint)
 * - jobid (so CNAPI can post status updates back to the job info object)
 * - requestMethod
 * - expects (if you want to check a specific running status of the machine)
 */
function setupRequest(job, cb) {
    job.endpoint = '/servers/' +
                   job.params['server_uuid'] + '/vms/' +
                   job.params['vm_uuid'] + '/reprovision';
    job.params.jobid = job.uuid;
    job.requestMethod = 'post';
    job.expects = 'running';

    return cb(null, 'Request has been setup!');
}



var workflow = module.exports = {
    name: 'reprovision-' + VERSION,
    version: VERSION,
    chain: [ {
        name: 'common.validate_params',
        timeout: 10,
        retry: 1,
        body: common.validateForZoneAction,
        modules: {}
    }, {
        name: 'common.setup_request',
        timeout: 10,
        retry: 1,
        body: setupRequest,
        modules: {}
    }, {
        name: 'cnapi.reprovision_vm',
        timeout: 10,
        retry: 1,
        body: common.zoneAction,
        modules: { restify: 'restify' }
    }, {
        name: 'cnapi.poll_task',
        timeout: 120,
        retry: 1,
        body: common.pollTask,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'vmapi.check_state',
        timeout: 60,
        retry: 1,
        body: common.checkState,
        modules: { sdcClients: 'sdc-clients' }
    }],
    timeout: 210,
    onerror: [ {
        name: 'On error',
        modules: {},
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }]
};
