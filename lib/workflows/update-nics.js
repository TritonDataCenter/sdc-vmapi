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

var async = require('async');
var common = require('./job-common');
var VERSION = '7.0.2';


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
    job.action = 'update_nics';
    job.server_uuid = job.params['server_uuid'];

    return cb(null, 'Request has been setup!');
}



var workflow = module.exports = {
    name: 'update-nics-' + VERSION,
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
        name: 'cnapi.update_vm',
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
        name: 'vmapi.check_updated',
        timeout: 90,
        retry: 1,
        body: common.checkUpdated,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'cnapi.release_vm_ticket',
        timeout: 60,
        retry: 1,
        body: common.releaseVMTicket,
        modules: { sdcClients: 'sdc-clients' }
    }],
    timeout: 300,
    onerror: [ {
        name: 'napi.cleanup_nics',
        timeout: 10,
        retry: 1,
        body: common.cleanupNics,
        modules: { sdcClients: 'sdc-clients', async: 'async' }
    }, {
        name: 'on_error.release_vm_ticket',
        modules: { sdcClients: 'sdc-clients' },
        body: function (job, cb) {
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
