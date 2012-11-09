/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


// This is not really needed, but javascriptlint will complain otherwise:
var sdcClients = require('sdc-clients');
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
    var dataset = encodeURIComponent('zones/' + job.params['vm_uuid']);
    job.endpoint = '/servers/' +
                   job.params['server_uuid'] + '/datasets/' +
                   dataset + '/snapshot';
    job.params.jobid = job.uuid;
    job.expects = 'running';
    job.requestMethod = 'post';

    return cb(null, 'Request has been setup!');
}



/*
 * Validates that the snapshot name to be created is present
 */
function validateSnapshotName(job, cb) {
    if (!job.params['name']) {
        cb('No snapshot name provided');
    }

    cb(null, 'Snapshot name is valid');
}



var workflow = module.exports = {
    name: 'snapshot-' + VERSION,
    version: VERSION,
    chain: [ {
        name: 'common.validate_params',
        timeout: 10,
        retry: 1,
        body: common.validateForZoneAction
    }, {
        name: 'common.validate_snapshot_name',
        timeout: 10,
        retry: 1,
        body: validateSnapshotName
    }, {
        name: 'common.setup_request',
        timeout: 10,
        retry: 1,
        body: setupRequest
    }, {
        name: 'cnapi.snapshot_vm',
        timeout: 10,
        retry: 1,
        body: common.zoneAction
    }],
    timeout: 180,
    onerror: [ {
        name: 'On error',
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }]
};
