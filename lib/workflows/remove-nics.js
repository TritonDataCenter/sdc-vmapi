/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016, Joyent, Inc.
 */

/*
 * This is the workflow for removing NICs from an SDC VM.
 */

var common = require('./job-common');
var async = require('async');

var VERSION = '7.0.6';


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
    job.action = 'remove_nics';
    job.server_uuid = job.params['server_uuid'];

    return cb(null, 'Request has been setup!');
}



/*
 * Removes a list of NICs from the machine.
 *
 * IMPORTANT: because workflow does not allow us to use 'common.removeNics' from
 * within a task this code unfortunately must be duplicated instead. If you make
 * changes here, make sure to apply the same changes in destroy.js.
 */
function removeNics(job, cb) {
    var macs = job.params['remove_nics'];
    var napi;

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
    name: 'remove-nics-' + VERSION,
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
        name: 'common.remove_network_params',
        timeout: 10,
        retry: 1,
        body: common.removeNetworkParams,
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
        name: 'cnapi.update_vm',
        timeout: 10,
        retry: 1,
        body: common.zoneAction,
        modules: { restify: 'restify' }
    }, {
        name: 'napi.remove_nics',
        timeout: 10,
        retry: 1,
        body: removeNics,
        modules: { sdcClients: 'sdc-clients', async: 'async' }
    }, {
        name: 'cnapi.wait_task',
        timeout: 120,
        retry: 1,
        body: common.waitTask,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'vmapi.check_updated',
        timeout: 90,
        retry: 1,
        body: common.checkUpdated,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'vmapi.put_vm',
        timeout: 60,
        retry: 1,
        body: common.putVm,
        modules: { sdcClients: 'sdc-clients' }
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
    timeout: 300,
    onerror: [ {
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
