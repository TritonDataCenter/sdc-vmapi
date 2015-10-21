/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * This is the workflow for destroying an SDC VM.
 */

var async = require('async');
var common = require('./job-common');
var restify = require('restify');
var VERSION = '7.1.0';


/*
 * Sets up a CNAPI VM destroy action request. Take a look at common.zoneAction.
 * Here you can set parameters such as:
 * - request endpoint (usually the VM endpoint)
 * - jobid (so CNAPI can post status updates back to the job info object)
 * - requestMethod
 * - expects (if you want to check a specific running status of the machine)
 */
function setupDestroyRequest(job, cb) {
    job.endpoint = '/servers/' +
                   job.params['server_uuid'] + '/vms/' +
                   job.params['vm_uuid'] + '?jobid=' + job.uuid;
    job.currentVm = job.params.currentVm;
    job.params.jobid = job.uuid;
    job.requestMethod = 'del';
    job.expects = 'destroyed';
    job.addedToUfds = true;
    job.action = 'destroy';
    job.server_uuid = job.params['server_uuid'];

    return cb(null, 'Destroy request has been setup!');
}

/*
 * Sets up a CNAPI VM stop action request. Take a look at common.zoneAction.
 * Here you can set parameters such as:
 * - request endpoint (usually the VM endpoint)
 * - jobid (so CNAPI can post status updates back to the job info object)
 * - requestMethod
 * - expects (if you want to check a specific running status of the machine)
 */
function setupStopRequest(job, cb) {
    job.endpoint = '/servers/' +
                   job.params['server_uuid'] + '/vms/' +
                   job.params['vm_uuid'] + '/stop' +
                   '?force=true&jobid=' + job.uuid;
    job.currentVm = job.params.currentVm;
    job.params.jobid = job.uuid;
    job.requestMethod = 'post';
    job.expects = 'stopped';
    job.addedToUfds = true;
    job.action = 'stop';
    job.server_uuid = job.params['server_uuid'];

    return cb(null, 'Stop request has been setup!');
}


function markVmAsDestroying(job, cb) {
    if (!job.currentVm) {
        cb(null, 'Skipping task -- VM missing from job');
        return;
    }

    var vmapi = restify.createJsonClient({
        url: vmapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    var path = '/vms/' + job.currentVm.uuid;
    job.currentVm.transitive_state = 'destroying';

    vmapi.put(path, job.currentVm, function (err, req, res, vm) {
        if (err) {
            cb(err, 'Could not mark VM as destroyed');
        } else {
            cb(null, 'VM marked as destroyed');
        }
    });
}

/*
 * Removes a list of NICs from the machine.
 *
 * IMPORTANT: because workflow does not allow us to use 'common.removeNics' from
 * within a task this code unfortunately must be duplicated instead. If you make
 * changes here, make sure to apply the same changes in remove-nics.js.
 */
function removeNics(job, cb) {
    var macs = [];
    var napi;

    if (!job.currentVm) {
        cb(null, 'Skipping task -- VM missing from job');
        return;
    }

    if (!job.currentVm.nics || !Array.isArray(job.currentVm.nics)) {
        cb(null, 'Skipping task -- VM is missing .nics');
        return;
    }

    job.currentVm.nics.forEach(function _appendMac(nic) {
        if (nic.mac) {
            macs.push(nic.mac);
        }
    });

    job.log.warn({macs: macs, vm: job.currentVm.uuid},
        'deleting NICs from NAPI');

    /*
     * Common code begins here.
     */

    if (!macs || !Array.isArray(macs) || macs.length === 0) {
        cb('No MAC addresses to remove');
        return;
    }

    napi = new sdcClients.NAPI({
        url: napiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    async.mapSeries(macs, function (mac, next) {
        napi.deleteNic(mac, function (err) {
            /*
             * when net-agent catches this first, we'll fail to delete it but
             * ignore since we want to be idempotent.
             *
             * Unfortunately sometimes NAPI returns 'body.code' and sometimes it
             * only returns an error message.
             */
            if (!err) {
                /* no error: deleted! */
                next();
            } else if (err && err.body && err.body.code &&
                err.body.code === 'ResourceNotFound') {
                /*
                 * Sometimes when NIC doesn't exist, we get 404 and body.code
                 * with value 'ResourceNotFound'.
                 */
                next();
            } else if (err && err.body && err.body.message &&
                err.body.message.match(/^napi_nics::.*does not exist$/)) {
                /*
                 * Other times it returns just a 500 and a message like:
                 *
                 *  'napi_nics::159123443660586 does not exist'
                 */
                next();
            } else {
                next(err);
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
    name: 'destroy-' + VERSION,
    version: VERSION,
    chain: [ {
        name: 'common.validate_params',
        timeout: 10,
        retry: 1,
        body: common.validateForZoneAction,
        modules: {}
    }, {
        name: 'common.setup_stop_request',
        timeout: 10,
        retry: 1,
        body: setupStopRequest,
        modules: {}
    }, {
        name: 'vmapi.mark_vm_as_destroying',
        timeout: 10,
        retry: 1,
        body: markVmAsDestroying,
        modules: { restify: 'restify' }
    }, {
        name: 'cnapi.acquire_vm_ticket',
        timeout: 10,
        retry: 1,
        body: common.acquireVMTicket,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'cnapi.wait_on_vm_ticket',
        timeout: 120,
        retry: 1,
        body: common.waitOnVMTicket,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'cnapi.stop_vm',
        timeout: 10,
        retry: 1,
        body: common.zoneAction,
        modules: { restify: 'restify' }
    }, {
        name: 'cnapi.wait_stop_vm_task',
        timeout: 120,
        retry: 1,
        body: common.waitTask,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'common.setup_destroy_request',
        timeout: 10,
        retry: 1,
        body: setupDestroyRequest,
        modules: {}
    }, {
        name: 'cnapi.destroy_vm',
        timeout: 10,
        retry: 1,
        body: common.zoneAction,
        modules: { restify: 'restify' }
    }, {
        name: 'cnapi.wait_destroy_vm_task',
        timeout: 120,
        retry: 1,
        body: common.waitTask,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'vmapi.refresh_vm',
        modules: { restify: 'restify' },
        body: common.refreshVm
    }, {
        name: 'napi.remove_nics',
        timeout: 30,
        retry: 1,
        body: removeNics,
        modules: { sdcClients: 'sdc-clients', async: 'async' }
    }, {
        name: 'fwapi.update',
        timeout: 10,
        retry: 1,
        body: common.updateFwapi,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'cnapi.release_vm_ticket',
        timeout: 60,
        retry: 1,
        body: common.releaseVMTicket,
        modules: { sdcClients: 'sdc-clients' }
    }],
    timeout: 180,
    onerror: [ {
        name: 'vmapi.refresh_vm',
        modules: { restify: 'restify' },
        body: common.refreshVm
    }, {
        name: 'on_error.release_vm_ticket',
        modules: { sdcClients: 'sdc-clients' },
        body: function (job, cb) {
            if (!job.ticket) {
                return cb();
            }
            var cnapi = new sdcClients.CNAPI({
                url: cnapiUrl,
                headers: { 'x-request-id': job.params['x-request-id'] }
            });
            cnapi.waitlistTicketRelease(job.ticket.uuid, function (err) {
                cb('Error executing job');
                return;
            });
        }
    }],
    oncancel: [ {
        name: 'on_cancel.release_vm_ticket',
        modules: { sdcClients: 'sdc-clients' },
        body: function (job, cb) {
            if (!job.ticket) {
                return cb();
            }
            var cnapi = new sdcClients.CNAPI({
                url: cnapiUrl,
                headers: { 'x-request-id': job.params['x-request-id'] }
            });
            cnapi.waitlistTicketRelease(job.ticket.uuid, function (err) {
                cb();
                return;
            });
        }
    } ]
};
