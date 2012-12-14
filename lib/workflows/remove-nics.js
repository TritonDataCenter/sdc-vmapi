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
    job.endpoint = '/servers/' +
                   job.params['server_uuid'] + '/vms/' +
                   job.params['vm_uuid'] + '/update';
    job.params.jobid = job.uuid;
    job.requestMethod = 'post';

    return cb(null, 'Request has been setup!');
}



/*
 * Provisions a list of NICs for the soon to be provisioned machine. The
 * networks list can contain a not null ip attribute on each object, which
 * denotes that we want to allocate that given IP for the correspondant network.
 * This task should be executed after DAPI has allocated a server
 */
function removeNics(job, cb) {
    var macs = job.params['remove_nics'];
    if (macs === undefined) {
        cb('MAC addresses are required');
        return;
    }

    var napi = new sdcClients.NAPI({ url: napiUrl });

    async.mapSeries(macs, function (mac, next) {
        napi.deleteNic(mac, function (err) {
            if (err) {
                next(err);
            } else {
                next();
            }
        });
    }, function (err2) {
        if (err2) {
            cb(err2);
        } else {
            cb(null, 'NICs removed');
        }
    });
}



var workflow = module.exports = {
    name: 'remove-nics-' + VERSION,
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
        name: 'cnapi.update_vm',
        timeout: 10,
        retry: 1,
        body: common.zoneAction
    }, {
        name: 'napi.remove_nics',
        timeout: 10,
        retry: 1,
        body: removeNics
    }, {
        name: 'cnapi.poll_task',
        timeout: 120,
        retry: 1,
        body: common.pollTask
    }, {
        name: 'vmapi.check_updated',
        timeout: 90,
        retry: 1,
        body: common.checkUpdated
    }],
    timeout: 300,
    onerror: [ {
        name: 'On error',
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }]
};
