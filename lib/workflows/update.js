/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var restify = require('restify');
var common = require('./job-common');

var VERSION = '7.1.3';

/*
 * Sets up a CNAPI VM action request. Take a look at common.zoneAction. Here you
 * can set parameters such as:
 * - request endpoint (usually the VM endpoint)
 * - jobid (so CNAPI can post status updates back to the job info object)
 * - requestMethod
 * - expects (if you want to check a specific running status of the machine)
 */
function setupRequest(job, cb) {
    var payload = job.params.payload;

    job.endpoint = '/servers/' +
                   job.params.server_uuid + '/vms/' +
                   job.params.vm_uuid + '/update';
    job.params.jobid = job.uuid;
    job.requestMethod = 'post';
    job.action = 'update';

    if (payload.new_owner_uuid) {
        // Keep a reference to the old one (debugging purposes)
        job.params.old_owner_uuid = job.params.owner_uuid;
        payload.owner_uuid = payload.new_owner_uuid;
    }

    return cb(null, 'Request has been setup!');
}


/*
 * Validates that the update parameters are valid. For now just make sure we are
 * not downsizing a VM that doesn't meet the requirements
 */
function validateUpdateParameters(job, cb) {
    var payload = job.params.payload;

    if (job.params.subtask !== 'resize') {
        return cb(null, 'Parameters OK, not a resize task');
    }

    function isDownsize() {
        var currentRam = job.params.current_ram;
        var newRam = payload.ram || payload.max_physical_memory;
        var currentDisk = job.params.current_quota;
        var newDisk = payload.quota;

        return (newRam && newRam < currentRam ||
            newDisk && newDisk < currentDisk);
    }

    // First check this is not a KVM VM
    if (job.params['vm_brand'] === 'kvm') {
        return cb('Cannot resize a KVM VM');
    }

    // Then make sure this is not a downsize
    if (isDownsize()) {
        return cb('Cannot downsize VM');
    }

    var imgapi = new sdcClients.IMGAPI({
        url: imgapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    imgapi.getImage(job.params.image_uuid, function (err, image) {
        if (err) {
            // If image is not found in the IMGAPI repository get its installed
            // manifest from the compute node
            if (err.name && err.name === 'ResourceNotFoundError') {
                var path = '/servers/' + job.params.server_uuid +
                    '/images/' + job.params.image_uuid;
                cnapi.get(path, function (cnapiErr, req, res, cnapiImage) {
                    onGetImage(cnapiErr, cnapiImage);
                });
            } else {
                cb(err);
            }
            return;
        }
        onGetImage(null, image);
    });

    function onGetImage(err, image) {
        if (err) {
            cb(err);
            return;
        }

        var ram = payload.ram || payload.max_physical_memory;
        var reqs = image.requirements;
        // Only check max values because downsizing is not currently supported
        var maxRam = reqs && reqs.max_ram;

        if (maxRam && ram > maxRam) {
            return cb('Specified RAM (' + ram + ') does not meet the maximum' +
                ' RAM requirement (' + maxRam + ')');
        } else {
            return cb(null, 'All parameters OK!');
        }
    }
}


/*
 * Checks the Server record where the VM is
 */
function checkCapacity(job, cb) {
    var payload = job.params.payload;

    if (job.params.subtask !== 'resize') {
        return cb(null, 'Not a resize task');
    }
    if (job.params.force === true) {
        return cb(null, 'Skipping checkCapacity (force=true)');
    }

    var currentRam = job.params.current_ram;
    var requiredRam = payload.ram || payload.max_physical_memory;
    var neededRam = requiredRam - currentRam;

    var currentDisk = job.params.current_quota;
    var requiredDisk = payload.quota;

    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });
    var params = { servers: [ job.params.server_uuid ] };
    cnapi.post('/capacity', params, function (err, req, res, obj) {
        if (err) {
            cb(err);
        } else {
            var ram = obj.capacities[job.params.server_uuid].ram;
            var disk = obj.capacities[job.params.server_uuid].disk / 1024;

            if (ram < neededRam) {
                return cb('Cannot resize VM, required RAM (' + neededRam +
                    ') exceeds the Server\'s available RAM (' + ram + ')');
            }
            if (requiredDisk && (disk < requiredDisk - currentDisk)) {
                var neededDisk = requiredDisk - currentDisk;
                return cb('Cannot resize VM, required disk (' + neededDisk +
                    ') exceeds the Server\'s available disk (' + disk + ')');
            }
            return cb(null, 'Server has enough capacity');
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
        name: 'common.validate_update',
        timeout: 10,
        retry: 1,
        body: validateUpdateParameters,
        modules: { sdcClients: 'sdc-clients', restify: 'restify' }
    }, {
        name: 'cnapi.check_capacity',
        timeout: 10,
        retry: 1,
        body: checkCapacity,
        modules: { restify: 'restify' }
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
        name: 'vmapi.refresh_vm',
        timeout: 10,
        retry: 1,
        body: common.refreshVm,
        modules: { restify: 'restify' }
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
