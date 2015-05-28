/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * A brief overview of this source file: what is its purpose.
 */

var common = require('./job-common');
var restify = require('restify');
var VERSION = '7.0.7';


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
                   job.params['vm_uuid'] + '?jobid=' + job.uuid;
    job.params.jobid = job.uuid;
    job.requestMethod = 'del';
    job.expects = 'destroyed';
    job.addedToUfds = true;
    job.action = 'destroy';
    job.server_uuid = job.params['server_uuid'];

    return cb(null, 'Request has been setup!');
}


/*
 * Ask CNAPI if the VM exists before queueing a delete job for it
 */
function ensureVmExists(job, cb) {
    var cnapi = new sdcClients.CNAPI({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    cnapi.getVm(job.params['server_uuid'], job.params['vm_uuid'],
    function (err, vm) {
        if (err) {
            if (err.name === 'ResourceNotFoundError') {
                job.params['skip_zone_action'] = true;
                return cb(null, 'VM doesn\'t exist');
            } else {
                return cb(err);
            }
        }

        job.currentVm = vm;
        return cb(null, 'VM exists');
    });
}


/*
 * Allow the VM to be marked as destroyed preemptively on VMAPI as soon as
 * CNAPI accepts our destroy task
 */
function markVmAsDestroyed(job, cb) {
    if (!job.currentVm) {
        cb(null, 'Skipping task given VM does not exist');
        return;
    }
    if (!job.currentVm.docker) {
        cb(null, 'Skipping task for non-Docker VMs');
        return;
    }

    var vmapi = restify.createJsonClient({
        url: vmapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    var path = '/vms/' + job.currentVm.uuid;
    job.currentVm.state = 'destroyed';

    vmapi.put(path, job.currentVm, function (err, req, res, vm) {
        if (err) {
            cb(err, 'Could not mark VM as destroyed');
        } else {
            cb(null, 'VM marked as destroyed');
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
        name: 'common.setup_request',
        timeout: 10,
        retry: 1,
        body: setupRequest,
        modules: {}
    }, {
        name: 'cnapi.ensure_vm',
        timeout: 20,
        retry: 1,
        body: ensureVmExists,
        modules: { sdcClients: 'sdc-clients' }
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
        name: 'cnapi.destroy_vm',
        timeout: 10,
        retry: 1,
        body: common.zoneAction,
        modules: { restify: 'restify' }
    }, {
        name: 'vmapi.mark_vm_as_destroyed',
        timeout: 10,
        retry: 1,
        body: markVmAsDestroyed,
        modules: { restify: 'restify' }
    }, {
        name: 'cnapi.poll_task',
        timeout: 120,
        retry: 1,
        body: common.pollTask,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'vmapi.refresh_vm',
        modules: { restify: 'restify' },
        body: common.refreshVm
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
