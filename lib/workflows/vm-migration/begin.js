/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */


var assert = require('assert-plus');
var restify = require('restify');
var sdcClients = require('sdc-clients');
var vasync = require('vasync');


/*
 * Selects a server for the VM. This function will send VM, image, package and
 * NIC tag requirements to DAPI, and let it figure out which server best fits
 * the requirements.
 *
 * Note that if you pass params['server_uuid'], this function will terminate
 * early, because you have already specified the server you want to provision.
 */
function allocateServer(job, cb) {
    var pkg = job.params.package;
    var img = job.params.image;
    var nicTagReqs = job.nicTagReqs;

    if (!nicTagReqs) {
        cb('NIC tag requirements must be present');
        return;
    }

    if (!img) {
        cb('Image is required');
        return;
    }

    if (job.params['server_uuid']) {
        cb(null, 'Server UUID present, no need to get allocation from DAPI');
        return;
    }

    // There is no sdc-client for CNAPI's DAPI yet
    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    /*
     * In case we're talking to an older DAPI from before heterogeneous pools
     * were supported, we select the first tag from each list of alternatives.
     */
    var nicTags = nicTagReqs.map(function extractFirstTag(arr) {
        return arr[0];
    });


    // Make sure our VM is placed on a CN away from the old VM.

    var payload = {
        vm: job.vmPayload,
        image: img,
        package: pkg,
        nic_tags: nicTags,
        nic_tag_requirements: nicTagReqs
    };

    job.log.info({ dapiPayload: payload }, 'Payload sent to DAPI');

    cnapi.post('/allocate', payload, function finish(err, req, res, body) {
        if (err) {
            cb(err);
            return;
        }

        var server_uuid = body.server.uuid;
        job.params.server_uuid = server_uuid;
        job.server_uuid = server_uuid;
        job.server_info = {
            sysinfo: {
                'Network Interfaces':
                    body.server.sysinfo['Network Interfaces'],
                'Virtual Network Interfaces':
                    body.server.sysinfo['Virtual Network Interfaces']
            }
        };


        cb(null, 'VM allocated to Server ' + server_uuid);
    });
}


function createProvisionPayload(job, cb) {
    var action = job.params.migrationTask.action;
    var record = job.params.migrationTask.record;

    if (action !== 'begin' && action !== 'full') {
        cb(null, 'OK - not applicable for action ' + action);
        return;
    }

    // Shallow clone for an object.
    function clone(theObj) {
        if (null === theObj || 'object' != typeof (theObj)) {
            return theObj;
        }

        var copy = theObj.constructor();

        for (var attr in theObj) {
            if (theObj.hasOwnProperty(attr)) {
                copy[attr] = theObj[attr];
            }
        }
        return copy;
    }


    var vmPayload = job.vmPayload = clone(job.params.vm);
    job.params.vmPayloadTest = vmPayload;

    // Mark as a migrating instance.
    vmPayload.do_not_inventory = true;
    vmPayload.vm_migration_target = true;

    // Allow overriding the UUID and alias (which would be maintained
    // otherwise) for testing.
    vmPayload.uuid = record.target_vm_uuid;
    if (job.params.override_alias) {
        vmPayload.alias = job.params.override_alias;
    }

    vmPayload.autoboot = false;

    delete vmPayload.server_uuid;
    delete vmPayload.state;
    delete vmPayload.zone_state;
    delete vmPayload.pid;
    delete vmPayload.tmpfs;

    cb(null, 'created vm migrate target payload');
}

function provisionVm(job, cb) {
    var action = job.params.migrationTask.action;

    if (action !== 'begin' && action !== 'full') {
        cb(null, 'OK - not applicable for action ' + action);
        return;
    }
    // Mark that we don't want to perform the common zone action routine.
    job.params.skip_zone_action = true;

    var vmapi = new sdcClients.VMAPI({
        log: job.log,
        headers: { 'x-request-id': job.params['x-request-id'] },
        url: vmapiUrl
    });
    job.log.info({vm_payload: job.vmPayload}, 'creating vm migration target');
    vmapi.createVmAndWait(job.vmPayload, function _onCreateVmCb(vmErr, vmJob) {
        var record = job.params.migrationTask.record;
        var target_server_uuid;

        if (vmErr) {
            var progressEntry = record.progress_history[
                job.params.migrationTask.progressIdx];

            progressEntry.message = 'reserving instance failed - '
                + vmErr.message;
            cb(vmErr);
            return;
        }

        // Record where the server landed.
        if (!vmJob || !vmJob.server_uuid) {
            cb('ERROR - create vm job missing server_uuid field');
            return;
        }

        target_server_uuid = vmJob.server_uuid;
        record.target_server_uuid = target_server_uuid;

        cb(null, 'OK - reservation provisioned successfully to server ' +
            target_server_uuid);
    });
}


module.exports = {
    tasks: {
        createProvisionPayload: {
            name: 'migration.createProvisionPayload',
            timeout: 1200,
            retry: 1,
            body: createProvisionPayload,
            modules: {
                restify: 'restify',
                sdcClients: 'sdc-clients'
            }
        },
        allocateServer: {
            name: 'migration.dapi.allocateServer',
            timeout: 60,
            retry: 1,
            body: allocateServer,
            modules: {
                restify: 'restify'
            }
        },
        provisionVm: {
            name: 'migration.provisionVm',
            timeout: 1200,
            retry: 1,
            body: provisionVm,
            modules: {
                restify: 'restify',
                sdcClients: 'sdc-clients'
            }
        }
    }
};
