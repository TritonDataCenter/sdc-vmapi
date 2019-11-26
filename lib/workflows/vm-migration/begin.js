/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */


var assert = require('assert-plus');
var restify = require('restify');
var sdcClients = require('sdc-clients');


/**
 * For BHYVE we may to tweak the quota on the root zfs dataset in order to be
 * able to create snapshots. We check if we need to do that here.
 */
function getSourceFilesystemDetails(job, cb) {
    var record = job.params.migrationTask.record;

    assert.object(job.params.vm, 'job.params.vm');
    assert.uuid(record.source_server_uuid, 'record.source_server_uuid');
    assert.uuid(record.vm_uuid, 'record.vm_uuid');

    if (job.params.vm.brand !== 'bhyve') {
        job.params.skip_zone_action = true;
        cb(null, 'OK - not necessary for ' + job.params.vm.brand + ' zone');
        return;
    }

    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    var url = '/servers/' +
        record.source_server_uuid + '/vms/' +
        record.vm_uuid + '/migrate';
    var payload = {
        action: 'get-filesystem-details',
        migrationTask: job.params.migrationTask,
        vm: job.params.vm,
        vm_uuid: record.vm_uuid
    };

    // Set where the result of the cnapi task will be stored.
    job.store_task_finish_event_in_attribute = 'sourceFilesystemDetails';

    cnapi.post(url, payload, function _getSourceFsCb(err, req, res, task) {
        if (err) {
            cb(err);
            return;
        }

        job.taskId = task.id;
        cb(null, 'OK - task id: ' + task.id + ' queued to CNAPI!');
    });
}


function getTargetFilesystemDetails(job, cb) {
    var record = job.params.migrationTask.record;

    assert.object(job.params.vm, 'job.params.vm');
    assert.uuid(record.target_server_uuid, 'record.target_server_uuid');
    assert.uuid(record.target_vm_uuid, 'record.target_vm_uuid');

    if (job.params.vm.brand !== 'bhyve') {
        job.params.skip_zone_action = true;
        cb(null, 'OK - not necessary for ' + job.params.vm.brand + ' zone');
        return;
    }

    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    var url = '/servers/' +
        record.target_server_uuid + '/vms/' +
        record.target_vm_uuid + '/migrate';
    var payload = {
        action: 'get-filesystem-details',
        migrationTask: job.params.migrationTask,
        vm: job.params.vm,
        vm_uuid: record.target_vm_uuid
    };

    // Set where the result of the cnapi task will be stored.
    job.store_task_finish_event_in_attribute = 'targetFilesystemDetails';

    cnapi.post(url, payload, function _getTargetFsCb(err, req, res, task) {
        if (err) {
            cb(err);
            return;
        }

        job.taskId = task.id;
        cb(null, 'OK - task id: ' + task.id + ' queued to CNAPI!');
    });
}


function storeSourceFilesystemDetails(job, cb) {
    var record = job.params.migrationTask.record;

    assert.object(job.params.vm, 'job.params.vm');

    if (job.params.vm.brand !== 'bhyve') {
        job.params.skip_zone_action = true;
        cb(null, 'OK - not necessary for ' + job.params.vm.brand + ' zone');
        return;
    }

    if (!job.sourceFilesystemDetails) {
        cb('Failed to retrieve BHYVE source filesystem details');
        return;
    }

    record.sourceFilesystemDetails = job.sourceFilesystemDetails;

    // Mark whether quota tweaking is necessary.
    if (!parseInt(record.sourceFilesystemDetails.quotaStr, 10) ||
            record.sourceFilesystemDetails.quotaStr !==
                record.sourceFilesystemDetails.reservationStr) {
        record.sourceFilesystemDetails.mustRemoveQuotaForSync = false;
    } else {
        record.sourceFilesystemDetails.mustRemoveQuotaForSync = true;
    }

    cb(null, 'OK - stored BHYVE filesystem details');
}


function storeTargetFilesystemDetails(job, cb) {
    var record = job.params.migrationTask.record;

    assert.object(job.params.vm, 'job.params.vm');

    if (job.params.vm.brand !== 'bhyve') {
        job.params.skip_zone_action = true;
        cb(null, 'OK - not necessary for ' + job.params.vm.brand + ' zone');
        return;
    }

    if (!job.targetFilesystemDetails) {
        cb('Failed to retrieve BHYVE target filesystem details');
        return;
    }

    record.targetFilesystemDetails = job.targetFilesystemDetails;

    // Mark whether quota tweaking is necessary.
    if (!parseInt(record.targetFilesystemDetails.quotaStr, 10) ||
            record.targetFilesystemDetails.quotaStr !==
                record.targetFilesystemDetails.reservationStr) {
        record.targetFilesystemDetails.mustRemoveQuotaForSync = false;
    } else {
        record.targetFilesystemDetails.mustRemoveQuotaForSync = true;
    }

    cb(null, 'OK - stored BHYVE filesystem details');
}


function createProvisionPayload(job, cb) {
    var record = job.params.migrationTask.record;

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
    var brand = vmPayload.brand;

    if (!brand) {
        cb('Error - vm does not have a brand');
        return;
    }

    // Mark as a migrating instance.
    vmPayload.do_not_inventory = true;
    vmPayload.vm_migration_target = true;
    // We will later change the create timestamp, so remember when this
    // instance was first created.
    if (!vmPayload.internal_metadata) {
        vmPayload.internal_metadata = {};
    }
    vmPayload.internal_metadata.vm_migration_create_timestamp =
        (new Date()).toISOString();

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

    // Handle delegated datasets for SmartOS and LX zones.
    if (Array.isArray(vmPayload.datasets) && vmPayload.datasets.length > 0) {
        if (brand.indexOf(['lx', 'joyent', 'joyent-minimal']) === -1) {
            cb('unexpected brand "' + brand + '" when vm has a datasets array');
            return;
        }

        if (vmPayload.datasets.length !== 1) {
            cb('unexpected - datasets array contains more than one entry');
            return;
        }

        // Delegated datasets are set through the delegate_dataset property.
        vmPayload.delegate_dataset = true;
        delete vmPayload.datasets;
    }

    // Docker - filter out filesystems that are added through the docker
    // provisioning process (e.g. /etc/hosts and docker shared volumes).
    if (brand === 'lx' && vmPayload.docker === true &&
            Array.isArray(vmPayload.filesystems)) {
        vmPayload.filesystems = vmPayload.filesystems.filter(
            function _filterFilesystems(entry) {
                // Handle docker DNS and hostname lofs.
                if (entry.type === 'lofs' &&
                        (entry.target === '/etc/resolv.conf' ||
                        entry.target === '/etc/hosts' ||
                        entry.target === '/etc/hostname')) {
                    return false;
                }
                return true;
            }).map(function _mapFilesystems(entry) {
                // Handle docker shared volume lofs by converting the zfs
                // filesystem path into a volume uuid (which will be
                // re-converted during the provisioning process).
                //    "filesystems": [
                //      {
                //        "source": "/zones/$ZONE_UUID/volumes/$VOL_UUID",
                //        "target": "/data/configdb",
                //        "type": "lofs"
                //      },
                if (entry.type === 'lofs') {
                    var volRegex = new RegExp('^/zones/' + record.vm_uuid +
                        '/volumes/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-' +
                        '[a-f0-9]{4}-[a-f0-9]{12})$');
                    var match = entry.source.match(volRegex);
                    if (match) {
                        // Convert the zfs filesystem path to be a volume uuid.
                        job.log.info(
                            {old_source: entry.source, new_source: match[1]},
                            'converting docker shared volume lofs mount');
                        entry.source = match[1];
                    }
                }
                return entry;
            });
    }

    // Convert nics into networks.
    vmPayload.networks = [];
    if (vmPayload.nics) {
        vmPayload.networks = vmPayload.nics.map(function _nicToMac(nic) {
            var netObj = {
                mac: nic.mac,
                uuid: nic.network_uuid
            };
            if (nic.primary) {
                netObj.primary = nic.primary;
            }
            return netObj;
        });

        delete vmPayload.nics;
    }

    // Convert disks.
    if (vmPayload.disks) {
        vmPayload.disks.forEach(function (disk) {
            // If image_uuid is defined - you cannot also define disk size
            // properties. The disk size properties will be set from the image
            // during provisioning.
            if (disk.image_uuid) {
                delete disk.size;
                delete disk.block_size;
                delete disk.refreservation;
            }

            // Bhyve refreservations should not be set (they are set
            // automagically during vmadm create).
            if (disk.refreservation && disk.size && brand === 'bhyve') {
                delete disk.refreservation;
            }

            // You cannot specify a path for a disk unless you set nocreate=true
            if (disk.path && !disk.nocreate) {
                // XXX: TODO: Could this cause a change to the resulting disk
                // path?
                delete disk.path;
            }

            // Cannot specify zfs_filesystem.
            delete disk.zfs_filesystem;
        });
    }

    // BHYVE hack - set cpu_type to 'host' when it's not set, otherwise the
    // provision will fail.
    if (brand === 'bhyve' && vmPayload.cpu_type === null) {
        if (vmPayload.image && vmPayload.image.cpu_type) {
            vmPayload.cpu_type = vmPayload.image.cpu_type;
        } else {
            vmPayload.cpu_type = 'host';
        }
        job.log.info({cpu_type: vmPayload.cpu_type}, 'setting cpu_type');
    }

    cb(null, 'created vm migrate target payload');
}

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
    var filteredNetworks = job.params.filteredNetworks;
    var record = job.params.migrationTask.record;

    if (!filteredNetworks) {
        cb('filteredNetworks param must be present');
        return;
    }

    if (!img) {
        cb('Image is required');
        return;
    }

    if (record.target_server_uuid) {
        job.vmPayload.server_uuid = record.target_server_uuid;
        cb(null, 'Server UUID present, no need to get allocation from DAPI');
        return;
    }

    // There is no sdc-client for CNAPI's DAPI yet
    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    /*
     * Determine the nic tag requirements from the loaded network objects.
     */
    var nicTagReqs = [];

    filteredNetworks.netInfo.forEach(function (net) {
        if (net.nic_tags_present) {
            nicTagReqs.push(net.nic_tags_present);
        } else {
            nicTagReqs.push([ net.nic_tag ]);
        }
    });

    /*
     * In case we're talking to an older DAPI from before heterogeneous pools
     * were supported, we select the first tag from each list of alternatives.
     */
    var nicTags = nicTagReqs.map(function extractFirstTag(arr) {
        return arr[0];
    });


    // When not overiding the vm uuid (i.e. for testing purpuses, to provision
    // to the the same server) make sure the target VM will be placed on a CN
    // away from the source VM.
    if (record.vm_uuid === record.target_vm_uuid) {
        job.vmPayload.locality = {
            far: job.params.vm.uuid,
            strict: true
        };
    }

    // The vmPayload must use vm.vm_uuid (not sure why it's different), anyway,
    // copy it across.
    job.vmPayload.vm_uuid = job.vmPayload.uuid;

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
            cb(err.message || err);
            return;
        }

        var server_uuid = body.server.uuid;

        // Ensure the allocated server is different. The only case we allow the
        // same server is for testing in COAL, where we are also changing the
        // target vm uuid.
        if (server_uuid === record.source_server_uuid &&
                record.vm_uuid === record.target_vm_uuid) {
            cb('Failed to allocate the instance to a different server');
            return;
        }

        job.vmPayload.server_uuid = server_uuid;
        record.target_server_uuid = server_uuid;

        cb(null, 'VM allocated to Server ' + server_uuid);
    });
}


function provisionVm(job, cb) {
    var vmapi = new sdcClients.VMAPI({
        log: job.log,
        headers: { 'x-request-id': job.params['x-request-id'] },
        url: vmapiUrl
    });
    job.log.info({vm_payload: job.vmPayload}, 'creating vm migration target');
    vmapi.createVmAndWait(job.vmPayload, function _onCreateVmCb(vmErr, vmJob) {
        var errorMsg;
        var record = job.params.migrationTask.record;
        var target_server_uuid;

        var progressEntry = record.progress_history[
            job.params.migrationTask.progressIdx];

        if (vmErr) {
            errorMsg = String(vmErr.message || vmErr).trim();

            // Sometimes we get back a huge vmadm error string, so we try and
            // do the best and just grab the first line from such a string.
            // Note that the vmadm string can come back escaped (e.g. '\\n').
            if (errorMsg && errorMsg.indexOf('\n') > 1) {
                progressEntry.errorDetail = errorMsg;
                errorMsg = errorMsg.split('\n')[0];
            } else if (errorMsg && errorMsg.indexOf('\\n') > 1) {
                progressEntry.errorDetail = errorMsg;
                errorMsg = errorMsg.split('\\n')[0];
            }

            progressEntry.message = 'reserving instance failed - ' + errorMsg;
            cb(errorMsg);
            return;
        }

        // Record where the server landed.
        if (!vmJob || !vmJob.server_uuid) {
            cb('ERROR - create vm job missing server_uuid field');
            return;
        }

        target_server_uuid = vmJob.server_uuid;
        record.target_server_uuid = target_server_uuid;
        progressEntry.provision_job_uuid = vmJob.uuid;

        cb(null, 'OK - reservation provisioned successfully to server ' +
            target_server_uuid + ', in job: ' + vmJob.uuid);
    });
}


function setCreateTimestamp(job, cb) {
    var record = job.params.migrationTask.record;

    assert.object(job.params.vm, 'job.params.vm');
    assert.uuid(record.target_server_uuid, 'record.target_server_uuid');
    assert.uuid(record.target_vm_uuid, 'record.target_vm_uuid');

    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    var url = '/servers/' +
        record.target_server_uuid + '/vms/' +
        record.target_vm_uuid + '/migrate';
    var payload = {
        action: 'set-create-timestamp',
        migrationTask: job.params.migrationTask,
        vm: job.params.vm,
        vm_uuid: record.target_vm_uuid
    };

    cnapi.post(url, payload, function _setCreateTimeCb(err, req, res, task) {
        if (err) {
            cb(err);
            return;
        }

        job.taskId = task.id;
        cb(null, 'OK - task id: ' + task.id + ' queued to CNAPI!');
    });
}


function startSyncWhenAutomatic(job, cb) {
    var record = job.params.migrationTask.record;

    if (!record.automatic) {
        cb(null, 'OK - ignoring since this is not an automatic migration');
        return;
    }

    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: {'x-request-id': job.params['x-request-id']},
        url: vmapiUrl
    });

    var url = '/vms/' + job.params.vm_uuid +
        '?action=migrate' +
        '&migration_action=sync' +
        '&is_migration_subtask=true'; // Keep record in the 'running' state.
    rawVmapi.post(url, function (err, req, res, body) {
        if (err) {
            cb(err);
            return;
        }

        if (!body.job_uuid) {
            cb(new Error('No job_uuid returned in migration sync call'));
            return;
        }

        cb(null, 'OK - sync started, job: ' + body.job_uuid);
    });
}


module.exports = {
    tasks: {
        createProvisionPayload: {
            name: 'migration.createProvisionPayload',
            timeout: 60,
            retry: 1,
            body: createProvisionPayload,
            modules: {
                restify: 'restify',
                sdcClients: 'sdc-clients'
            }
        },
        allocateServer: {
            name: 'migration.dapi.allocateServer',
            timeout: 300,
            retry: 1,
            body: allocateServer,
            modules: {
                restify: 'restify'
            }
        },
        getSourceFilesystemDetails: {
            name: 'migration.begin.getSourceFilesystemDetails',
            timeout: 300,
            retry: 1,
            body: getSourceFilesystemDetails,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        getTargetFilesystemDetails: {
            name: 'migration.begin.getTargetFilesystemDetails',
            timeout: 300,
            retry: 1,
            body: getTargetFilesystemDetails,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        provisionVm: {
            name: 'migration.provisionVm',
            timeout: 900,
            retry: 1,
            body: provisionVm,
            modules: {
                restify: 'restify',
                sdcClients: 'sdc-clients'
            }
        },
        startSyncWhenAutomatic: {
            name: 'migration.startSyncWhenAutomatic',
            timeout: 120,
            retry: 1,
            body: startSyncWhenAutomatic,
            modules: {
                restify: 'restify'
            }
        },
        setCreateTimestamp: {
            name: 'migration.setCreateTimestamp',
            timeout: 300,
            retry: 1,
            body: setCreateTimestamp,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        storeSourceFilesystemDetails: {
            name: 'migration.begin.storeSourceFilesystemDetails',
            timeout: 60,
            retry: 1,
            body: storeSourceFilesystemDetails,
            modules: {
                assert: 'assert-plus'
            }
        },
        storeTargetFilesystemDetails: {
            name: 'migration.begin.storeTargetFilesystemDetails',
            timeout: 60,
            retry: 1,
            body: storeTargetFilesystemDetails,
            modules: {
                assert: 'assert-plus'
            }
        }
    }
};
