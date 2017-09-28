/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * This is the workflow for destroying an SDC VM.
 */

var async = require('async');

var restify = require('restify');

var common = require('./job-common');
var nfsVolumes = require('./nfs-volumes');

var VERSION = '7.1.1';


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
    job.currentVm = job.params.currentVm;
    job.params.jobid = job.uuid;
    job.requestMethod = 'del';
    job.expects = 'destroyed';
    job.addedToUfds = true;
    job.action = 'destroy';
    job.server_uuid = job.params['server_uuid'];

    return cb(null, 'Request has been setup!');
}


/*
 * Allow the VM to be marked as destroyed preemptively on VMAPI as soon as
 * CNAPI accepts our destroy task
 */
function markVmAsDestroyed(job, cb) {
    if (!job.currentVm) {
        cb(null, 'Skipping task -- VM missing from job');
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
        name: 'cnapi.wait_task',
        timeout: 120,
        retry: 1,
        body: common.waitTask,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'vmapi.refresh_vm',
        modules: { restify: 'restify' },
        body: common.refreshVm
    },
    {
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
    },
    /*
     * It is possible for this operation to either fail or never happen (due to
     * the workflow job failing before getting to this task, etc.). It is not a
     * critical problem though. Indeed, in this case, a background async process
     * running in the VOLAPI zone will monitor VMs changing their state to
     * 'failed' or 'deleted' to remove the corresponding references from the
     * volumes they reference. We're still performing this operation here so
     * that, *if possible*, the references from a VM to a volume are removed as
     * soon as the corresponding user command (e.g "docker rm
     * mounting-container") completes. This also explains the short timeout: if
     * this task would slow down a destroy job by more than 10 seconds, then we
     * timeout the whole job instead so that users can get a response back
     * quicker. We also add this task at the end of the tasks chain (more
     * precisely before the release ticket task, but that one runs on error) so
     * that all other tasks have a chance to run, regardless of whether this one
     * succeeds or not.
     */
    {
        name: 'volapi.remove_volumes_references',
        timeout: 10,
        retry: 1,
        body: nfsVolumes.removeVolumesReferences,
        modules: { sdcClients: 'sdc-clients', vasync: 'vasync' }
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
