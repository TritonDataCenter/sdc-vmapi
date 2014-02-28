/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var common = require('./job-common');

var VERSION = '7.0.9';


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
    job.action = 'update';

    if (job.params['new_owner_uuid']) {
        // Keep a reference to the old one (debugging purposes)
        job.params['old_owner_uuid'] = job.params['owner_uuid'];
        job.params['owner_uuid'] = job.params['new_owner_uuid'];
    }

    return cb(null, 'Request has been setup!');
}


/*
 * Validates that the update parameters are valid. For now just make sure we are
 * not downsizing a VM that doesn't meet the requirements
 */
function validateUpdateParameters(job, cb) {
    if (job.params.subtask !== 'resize') {
        return cb(null, 'Parameters OK, not a resize task');
    }

    // First check this is not a KVM VM and then use min/max requirements
    // to determine if the resize can be allowed
    if (job.params['vm_brand'] === 'kvm') {
        return cb('Cannot resize a KVM VM');
    }

    var imgapi = new sdcClients.IMGAPI({
        url: imgapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    imgapi.getImage(job.params['image_uuid'], function (err, image) {
        if (err) {
            if (err.code && err.code === 'ResourceNotFound') {
                cb('Cannot resize a VM if source Image cannot be found');
            } else {
                cb(err);
            }
            return;
        }

        var ram = job.params['ram'] || job.params['max_physical_memory'];
        var reqs = image.requirements;
        // If min_ram/max_ram don't exist then we allow the resize
        var minRam = reqs && reqs.min_ram;
        var maxRam = reqs && reqs.max_ram;

        if ((minRam && ram < minRam) || (maxRam && ram > maxRam))  {
            return cb('Specified RAM does not meet the minimum/maximum ' +
             'requirements');
        } else {
            return cb(null, 'All parameters OK!');
        }
    });
}


var workflow = module.exports = {
    name: 'update-' + VERSION,
    version: VERSION,
    chain: [ {
        name: 'common.validate_params',
        timeout: 10,
        retry: 1,
        body: common.validateForZoneAction,
        modules: {}
    }, {
        name: 'papi.get_package',
        timeout: 10,
        retry: 3,
        body: common.getPackage,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'common.validate_update',
        timeout: 10,
        retry: 1,
        body: validateUpdateParameters,
        modules: { sdcClients: 'sdc-clients' }
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
    } ],
    timeout: 300,
    onerror: [ {
        name: 'On error',
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
    } ],
    oncancel: [ {
        name: 'On cancel',
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
