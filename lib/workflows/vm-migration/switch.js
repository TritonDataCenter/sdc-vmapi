/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */


var assert = require('assert-plus');
var restify = require('restify');
var sdcClients = require('sdc-clients');
var vasync = require('vasync');


function stopSourceVm(job, cb) {
    if (job.params.vm.state === 'stopped') {
        job.workflow_job_uuid = null;
        cb(null, 'OK - vm is stopped already');
        return;
    }

    // Send a progress event.
    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: {'x-request-id': job.params['x-request-id']},
        url: vmapiUrl
    });
    var vmapi = new sdcClients.VMAPI({
        log: job.log,
        headers: {'x-request-id': job.params['x-request-id']},
        url: vmapiUrl
    });

    var progressUrl = '/migrations/' + job.params.vm_uuid + '/progress';
    var event = {
        current_progress: 3,
        message: 'stopping the instance',
        phase: 'switch',
        state: 'running',
        total_progress: 100,
        type: 'progress'
    };

    rawVmapi.post(progressUrl, event, function _onNotifyProgressCb(err) {
        if (err) {
            job.log.warn({err: err, event: event},
                'Unable to notify progress event: ' + err);
        }
        // Intentionally no callback here (fire and forget).
    });

    vmapi.stopVm({uuid: job.vm_uuid}, function (err, body) {
        if (err) {
            cb(err);
            return;
        }

        // Set the workflow job uuid for the waitForWorkflowJob step.
        job.workflow_job_uuid = body.job_uuid;
        assert.uuid(job.workflow_job_uuid, 'job.workflow_job_uuid');

        cb(null, 'OK - vm stop called, job uuid: ' + body.job_uuid);
    });
}


function ensureSourceVmStopped(job, cb) {
    var vmapi = new sdcClients.VMAPI({
        headers: {'x-request-id': job.params['x-request-id']},
        url: vmapiUrl
    });

    vmapi.getVm({uuid: job.vm_uuid}, function (err, vm) {
        if (err) {
            cb(err);
            return;
        }

        if (vm.state !== 'stopped') {
            cb(new Error('Vm is no longer stopped - state: ' + vm.state));
            return;
        }

        job.vmStopped = vm;
        cb(null, 'OK - source vm is stopped');
    });
}


function startFinalSync(job, cb) {
    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: {'x-request-id': job.params['x-request-id']},
        url: vmapiUrl
    });

    var url = '/vms/' + job.params.vm_uuid +
        '?action=migrate' +
        '&migration_action=sync' +
        '&is_final_sync=true' +
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

        // Set the workflow job uuid for the waitForWorkflowJob step.
        job.workflow_job_uuid = body.job_uuid;
        cb(null, 'OK - final migration sync started, job: ' + body.job_uuid);
    });
}


function getRecord(job, cb) {
    // Send a progress event.
    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: {'x-request-id': job.params['x-request-id']},
        url: vmapiUrl
    });
    var progressUrl = '/migrations/' + job.params.vm_uuid + '/progress';
    var event = {
        current_progress: 55,
        message: 'filesytem sync finished, switching instances',
        phase: 'switch',
        state: 'running',
        total_progress: 100,
        type: 'progress'
    };
    rawVmapi.post(progressUrl, event, function _onNotifyProgressCb(err) {
        if (err) {
            job.log.warn({err: err, event: event},
                'Unable to notify progress event: ' + err);
        }
        // Intentionally no callback here (fire and forget).
    });

    // Get the *raw* migration record.
    var url = '/migrations/' + job.params.vm_uuid + '?format=raw';

    rawVmapi.get(url, function _getRecordCb(err, req, res, record) {
        if (err) {
            job.log.error({err: err}, 'Unable to retrieve migration record: ' +
                err);
            cb(err);
            return;
        }

        job.params.migrationTask.record = record;

        cb(null, 'OK - got the latest migration record');
    });
}


function reserveNetworkIps(job, cb) {
    if (job.params.migrationTask.targetAlreadyHasDNI) {
        cb(null, 'OK - target VM already has DNI set');
        return;
    }

    // Send a progress event.
    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: {'x-request-id': job.params['x-request-id']},
        url: vmapiUrl
    });
    var progressUrl = '/migrations/' + job.params.vm_uuid + '/progress';
    var event = {
        current_progress: 60,
        message: 'reserving the IP addresses for the instance',
        phase: 'switch',
        state: 'running',
        total_progress: 100,
        type: 'progress'
    };
    rawVmapi.post(progressUrl, event, function _onNotifyProgressCb(err) {
        if (err) {
            job.log.warn({err: err, event: event},
                'Unable to notify progress event: ' + err);
        }
        // Intentionally no callback here (fire and forget).
    });

    // Reserve the IPs

    var napi = new sdcClients.NAPI({
        headers: {'x-request-id': job.params['x-request-id']},
        url: napiUrl
    });

    job.migration_reserved_nics = [];

    function reserveNicIP(nic, callback) {
        // TODO: Can we have multiple ip per nic?
        var ip = nic.ip;
        var mac = nic.mac;
        var network_uuid = nic.network_uuid;

        if (!mac) {
            callback(new Error('No mac for nic: ' + nic));
            return;
        }

        vasync.pipeline({arg: {}, funcs: [
            function getNetworkUuid(ctx, next) {
                if (ip && network_uuid) {
                    next();
                    return;
                }
                napi.getNic(mac, function _onGetNic(err, nicDetails) {
                    if (err) {
                        next(err);
                        return;
                    }
                    ip = nicDetails.ip;
                    network_uuid = nicDetails.network_uuid;
                });
            },

            function reserveIP(ctx, next) {
                if (!ip || !network_uuid) {
                    next(new Error('No ip or no network_uuid for nic: ' + nic));
                    return;
                }

                // Check if the IP is already reserved.
                napi.getIP(network_uuid, ip, function _onGetIpCb(err, ipObj) {
                    if (err) {
                        next(err);
                        return;
                    }
                    if (ipObj.reserved) {
                        next();
                        return;
                    }

                    // Reserve the IP address.
                    napi.updateIP(network_uuid, ip, {reserved: true},
                            function _onReserveIpCb(updateErr) {
                        if (updateErr) {
                            next(updateErr);
                            return;
                        }
                        // Keep a record of the ip that were reserved.
                        job.migration_reserved_nics.push(
                            {network_uuid: network_uuid, ip: ip});
                        next();
                    });
                });
            }
        ]}, callback);
    }

    vasync.forEachParallel({inputs: job.vmStopped.nics, func: reserveNicIP},
            function _reserveAllNicIPsCb(err) {
        if (err) {
            cb(err);
            return;
        }

        cb(null, 'OK - reserved ' + job.vmStopped.nics.length + ' ips');
    });
}


function storeReservedNetworkIps(job, cb) {
    if (!Array.isArray(job.migration_reserved_nics) ||
            job.migration_reserved_nics.length === 0) {
        cb(null, 'OK - no reserved IPS');
        return;
    }

    var record = job.params.migrationTask.record;

    // Keep an entry in the record.
    record.reserved_nics = job.migration_reserved_nics;

    // Keep a running history of the record (for debugging purposes).
    job.migrationRecordHistory.push(record);

    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: {'x-request-id': job.params['x-request-id']},
        url: vmapiUrl
    });
    var url = '/migrations/' + job.params.vm_uuid + '/store';

    rawVmapi.post(url, record, function _storeRecordCb(err, req, res) {
        if (err) {
            job.log.error({err: err}, 'Unable to store migration record: ' +
                err);
            cb(err);
            return;
        }

        // TODO: Store ETag?
        job.params.migrationTask.record = record;

        cb(null, 'OK - added the reserved IP addresses to migration record');
    });
}


function unreserveNetworkIps(job, cb) {
    if (!Array.isArray(job.migration_reserved_nics) ||
            job.migration_reserved_nics.length === 0) {
        cb(null, 'OK - no reserved NICs');
        return;
    }

    var napi = new sdcClients.NAPI({
        headers: {'x-request-id': job.params['x-request-id']},
        url: napiUrl
    });

    // Unreserve the IP address.
    function unreserveNicIp(entry, callback) {
        var ip = entry.ip;
        var network_uuid = entry.network_uuid;

        napi.updateIP(network_uuid, ip, {reserved: false}, callback);
    }

    vasync.forEachParallel({inputs: job.migration_reserved_nics,
            func: unreserveNicIp},
            function _unreserveAllNicIpsCb(err) {
        // TODO: This would be better as a warning, and allowed to continue on?
        if (err) {
            cb(err);
            return;
        }

        cb(null, 'OK - unreserved ' + job.migration_reserved_nics.length +
            ' ips');
    });
}


function setupTargetFilesystem(job, cb) {
    var record = job.params.migrationTask.record;

    assert.uuid(record.target_vm_uuid, 'record.target_vm_uuid');
    assert.uuid(record.target_server_uuid, 'record.target_server_uuid');

    // Send a progress event.
    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: {'x-request-id': job.params['x-request-id']},
        url: vmapiUrl
    });
    var progressUrl = '/migrations/' + job.params.vm_uuid + '/progress';
    var event = {
        current_progress: 65,
        message: 'setting up the target filesystem',
        phase: 'switch',
        state: 'running',
        total_progress: 100,
        type: 'progress'
    };
    rawVmapi.post(progressUrl, event, function _onNotifyProgressCb(err) {
        if (err) {
            job.log.warn({err: err, event: event},
                'Unable to notify progress event: ' + err);
        }
        // Intentionally no callback here (fire and forget).
    });

    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    var url = '/servers/' +
        record.target_server_uuid + '/vms/' +
        record.target_vm_uuid + '/migrate';
    var payload = {
        action: 'setup-filesystem',
        migrationTask: job.params.migrationTask,
        vm: job.params.vm,
        vm_uuid: record.target_vm_uuid
    };

    cnapi.post(url, payload, function _addSupportDsCb(err, req, res, task) {
        if (err) {
            cb(err);
            return;
        }

        job.taskId = task.id;
        cb(null, 'OK - task id: ' + task.id + ' queued to CNAPI!');
    });
}


function disableSourceVmAutoboot(job, cb) {
    var record = job.params.migrationTask.record;

    if (job.params.vm.autoboot === false) {
        cb(null, 'OK - autoboot is already disabled');
        return;
    }

    assert.uuid(record.source_server_uuid, 'record.source_server_uuid');
    assert.uuid(record.vm_uuid, 'record.vm_uuid');

    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    var url = '/servers/' +
        record.source_server_uuid + '/vms/' +
        record.vm_uuid + '/migrate';
    var payload = {
        action: 'set-autoboot',
        migrationTask: job.params.migrationTask,
        vm_uuid: record.vm_uuid,
        value: 'false'
    };

    cnapi.post(url, payload, function _disableAutobootCb(err, req, res, task) {
        if (err) {
            cb(err);
            return;
        }

        job.taskId = task.id;
        cb(null, 'OK - task id: ' + task.id + ' queued to CNAPI!');
    });
}


function setTargetVmAutoboot(job, cb) {
    var record = job.params.migrationTask.record;

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
        action: 'set-autoboot',
        migrationTask: job.params.migrationTask,
        vm_uuid: record.target_vm_uuid,
        value: (job.params.vm.autoboot ? 'true' : 'false')
    };

    cnapi.post(url, payload, function _setAutobootCb(err, req, res, task) {
        if (err) {
            cb(err);
            return;
        }

        job.taskId = task.id;
        cb(null, 'OK - task id: ' + task.id + ' queued to CNAPI!');
    });
}


function setSourceDoNotInventory(job, cb) {
    var record = job.params.migrationTask.record;

    assert.uuid(record.source_server_uuid, 'record.source_server_uuid');
    assert.uuid(record.vm_uuid, 'record.vm_uuid');

    // Send a progress event.
    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: {'x-request-id': job.params['x-request-id']},
        url: vmapiUrl
    });
    var progressUrl = '/migrations/' + job.params.vm_uuid + '/progress';
    var event = {
        current_progress: 75,
        message: 'hiding the original instance',
        phase: 'switch',
        state: 'running',
        total_progress: 100,
        type: 'progress'
    };
    rawVmapi.post(progressUrl, event, function _onNotifyProgressCb(err) {
        if (err) {
            job.log.warn({err: err, event: event},
                'Unable to notify progress event: ' + err);
        }
        // Intentionally no callback here (fire and forget).
    });

    // Set DNI flag on the source instance.
    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });
    var url = '/servers/' +
        record.source_server_uuid + '/vms/' +
        record.vm_uuid + '/migrate';
    var payload = {
        action: 'set-do-not-inventory',
        migrationTask: job.params.migrationTask,
        vm_uuid: job.params.vm_uuid,
        value: 'true'
    };

    cnapi.post(url, payload, function _setDoNotInventory(err, req, res, task) {
        if (err) {
            cb(err);
            return;
        }

        job.taskId = task.id;
        cb(null, 'OK - task id: ' + task.id + ' queued to CNAPI!');
    });
}


function updateVmServerUuid(job, cb) {
    var record = job.params.migrationTask.record;

    assert.uuid(record.target_server_uuid, 'record.target_server_uuid');
    assert.uuid(record.target_vm_uuid, 'record.target_vm_uuid');
    assert.uuid(record.vm_uuid, 'record.vm_uuid');

    // Don't need to do this if the vm uuid is different.
    if (record.vm_uuid !== record.target_vm_uuid) {
        cb(null, 'OK - vm_uuid is different on target server - skip');
        return;
    }

    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: {'x-request-id': job.params['x-request-id']},
        url: vmapiUrl
    });
    var url = '/migrations/' + job.params.vm_uuid + '/updateVmServerUuid';
    var data = {
        server_uuid: record.target_server_uuid
    };

    rawVmapi.post(url, data, function _updateVmServerUuidCb(err) {
        if (err) {
            job.log.error({err: err},
                'Unable to switch vm server_uuid: ' + err);
            cb(err);
            return;
        }

        cb(null, 'OK - updated vm server uuid');
    });
}


function removeTargetDoNotInventory(job, cb) {
    // Send a progress event.
    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: {'x-request-id': job.params['x-request-id']},
        url: vmapiUrl
    });
    var progressUrl = '/migrations/' + job.params.vm_uuid + '/progress';
    var event = {
        current_progress: 85,
        message: 'promoting the migrated instance',
        phase: 'switch',
        state: 'running',
        total_progress: 100,
        type: 'progress'
    };
    rawVmapi.post(progressUrl, event, function _onNotifyProgressCb(err) {
        if (err) {
            job.log.warn({err: err, event: event},
                'Unable to notify progress event: ' + err);
        }
        // Intentionally no callback here (fire and forget).
    });

    // Remove do-not-inventory status.
    var record = job.params.migrationTask.record;

    assert.uuid(record.target_server_uuid, 'record.target_server_uuid');
    assert.uuid(record.target_vm_uuid, 'record.target_vm_uuid');

    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });
    var vmUuid = record.target_vm_uuid;

    var url = '/servers/' + record.target_server_uuid + '/vms/' + vmUuid +
        '/migrate';
    var payload = {
        action: 'set-do-not-inventory',
        migrationTask: job.params.migrationTask,
        vm_uuid: vmUuid,
        value: 'false'
    };

    cnapi.post(url, payload, function _remDoNotInventory(err, req, res, task) {
        if (err) {
            cb(err);
            return;
        }

        job.taskId = task.id;
        cb(null, 'OK - task id: ' + task.id + ' queued to CNAPI!');
    });
}


function removeSourceSnapshots(job, cb) {
    // Send a progress event.
    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: {'x-request-id': job.params['x-request-id']},
        url: vmapiUrl
    });
    var progressUrl = '/migrations/' + job.params.vm_uuid + '/progress';
    var event = {
        current_progress: 90,
        message: 'removing sync snapshots',
        phase: 'switch',
        state: 'running',
        total_progress: 100,
        type: 'progress'
    };
    rawVmapi.post(progressUrl, event, function _onNotifyProgressCb(err) {
        if (err) {
            job.log.warn({err: err, event: event},
                'Unable to notify progress event: ' + err);
        }
        // Intentionally no callback here (fire and forget).
    });

    // Remove sync snapshots.
    var record = job.params.migrationTask.record;

    assert.uuid(record.source_server_uuid, 'record.source_server_uuid');
    assert.uuid(record.vm_uuid, 'record.vm_uuid');

    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });
    var vmUuid = record.vm_uuid;

    var url = '/servers/' + record.source_server_uuid + '/vms/' + vmUuid +
        '/migrate';
    var payload = {
        action: 'remove-sync-snapshots',
        migrationTask: job.params.migrationTask,
        vm: job.params.vm,
        vm_uuid: vmUuid
    };

    cnapi.post(url, payload, function _remDoNotInventory(err, req, res, task) {
        if (err) {
            cb(err);
            return;
        }

        job.taskId = task.id;
        cb(null, 'OK - task id: ' + task.id + ' queued to CNAPI!');
    });
}


function removeTargetSnapshots(job, cb) {
    var record = job.params.migrationTask.record;

    assert.uuid(record.target_server_uuid, 'record.target_server_uuid');
    assert.uuid(record.target_vm_uuid, 'record.target_vm_uuid');

    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });
    var vmUuid = record.target_vm_uuid;

    var url = '/servers/' + record.target_server_uuid + '/vms/' + vmUuid +
        '/migrate';
    var payload = {
        action: 'remove-sync-snapshots',
        migrationTask: job.params.migrationTask,
        vm: job.params.vm,
        vm_uuid: vmUuid
    };

    cnapi.post(url, payload, function _remDoNotInventory(err, req, res, task) {
        if (err) {
            cb(err);
            return;
        }

        job.taskId = task.id;
        cb(null, 'OK - task id: ' + task.id + ' queued to CNAPI!');
    });
}


function restoreIndestructibleZoneroot(job, cb) {
    var record = job.params.migrationTask.record;

    assert.object(job.params.vm, 'job.params.vm');
    assert.uuid(record.target_server_uuid, 'record.target_server_uuid');
    assert.uuid(record.target_vm_uuid, 'record.target_vm_uuid');

    if (!job.params.vm.indestructible_zoneroot) {
        job.params.skip_zone_action = true;
        cb(null, 'OK - indestructible_zoneroot is not set');
        return;
    }

    // Send a progress event.
    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: {'x-request-id': job.params['x-request-id']},
        url: vmapiUrl
    });
    var progressUrl = '/migrations/' + job.params.vm_uuid + '/progress';
    var event = {
        current_progress: 77,
        message: 'enabling deletion protection',
        phase: 'switch',
        state: 'running',
        total_progress: 100,
        type: 'progress'
    };
    rawVmapi.post(progressUrl, event, function _onNotifyProgressCb(err) {
        if (err) {
            job.log.warn({err: err, event: event},
                'Unable to notify progress event: ' + err);
        }
        // Intentionally no callback here (fire and forget).
    });

    // Set indestructible_zoneroot on the target instance.
    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });
    var url = '/servers/' +
        record.target_server_uuid + '/vms/' +
        record.target_vm_uuid + '/migrate';
    var payload = {
        action: 'set-indestructible-zoneroot',
        migrationTask: job.params.migrationTask,
        vm_uuid: record.target_vm_uuid,
        value: 'true'
    };

    cnapi.post(url, payload, function _setIndestructible(err, req, res, task) {
        if (err) {
            cb(err);
            return;
        }

        job.taskId = task.id;
        cb(null, 'OK - task id: ' + task.id + ' queued to CNAPI!');
    });
}


function restoreIndestructibleDelegated(job, cb) {
    var record = job.params.migrationTask.record;

    assert.object(job.params.vm, 'job.params.vm');
    assert.uuid(record.target_server_uuid, 'record.target_server_uuid');
    assert.uuid(record.target_vm_uuid, 'record.target_vm_uuid');

    if (!job.params.vm.indestructible_delegated) {
        job.params.skip_zone_action = true;
        cb(null, 'OK - indestructible_delegated is not set');
        return;
    }

    // Send a progress event.
    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: {'x-request-id': job.params['x-request-id']},
        url: vmapiUrl
    });
    var progressUrl = '/migrations/' + job.params.vm_uuid + '/progress';
    var event = {
        current_progress: 78,
        message: 'enabling deletion protection',
        phase: 'switch',
        state: 'running',
        total_progress: 100,
        type: 'progress'
    };
    rawVmapi.post(progressUrl, event, function _onNotifyProgressCb(err) {
        if (err) {
            job.log.warn({err: err, event: event},
                'Unable to notify progress event: ' + err);
        }
        // Intentionally no callback here (fire and forget).
    });

    // Set indestructible_zoneroot on the target instance.
    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });
    var url = '/servers/' +
        record.target_server_uuid + '/vms/' +
        record.target_vm_uuid + '/migrate';
    var payload = {
        action: 'set-indestructible-delegated',
        migrationTask: job.params.migrationTask,
        vm_uuid: record.target_vm_uuid,
        value: 'true'
    };

    cnapi.post(url, payload, function _setIndestructible(err, req, res, task) {
        if (err) {
            cb(err);
            return;
        }

        job.taskId = task.id;
        cb(null, 'OK - task id: ' + task.id + ' queued to CNAPI!');
    });
}


function recordServerDetails(job, cb) {
    var record = job.params.migrationTask.record;

    // Record where the migration source now resides.
    record.original_source_server_uuid = record.source_server_uuid;
    record.source_server_uuid = record.target_server_uuid;

    cb(null, 'OK - instance now on server: ' + record.source_server_uuid);
}


function startTargetVm(job, cb) {
    // Send a progress event.
    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: {'x-request-id': job.params['x-request-id']},
        url: vmapiUrl
    });
    var progressUrl = '/migrations/' + job.params.vm_uuid + '/progress';
    var event = {
        current_progress: 95,
        message: 'starting the migrated instance',
        phase: 'switch',
        state: 'running',
        total_progress: 100,
        type: 'progress'
    };
    rawVmapi.post(progressUrl, event, function _onNotifyProgressCb(err) {
        if (err) {
            job.log.warn({err: err, event: event},
                'Unable to notify progress event: ' + err);
        }
        // Intentionally no callback here (fire and forget).
    });

    // Start the VM.
    var record = job.params.migrationTask.record;

    assert.uuid(record.target_vm_uuid, 'record.target_vm_uuid');

    var vmapi = new sdcClients.VMAPI({
        headers: {'x-request-id': job.params['x-request-id']},
        url: vmapiUrl
    });

    // Ensure that the initial state was running.
    if (job.params.vm.state !== 'running') {
        cb(null, 'OK - initial vm state was not running, state: ' +
            job.params.vm.state);
        return;
    }

    vmapi.startVm({uuid: record.target_vm_uuid}, function (err, body) {
        if (err) {
            cb(err);
            return;
        }

        // Set the workflow job uuid for the waitForWorkflowJob step.
        job.workflow_job_uuid = body.job_uuid;

        cb(null, 'OK - vm start workflow running, job uuid: ' + body.job_uuid);
    });
}


function startSourceVm(job, cb) {
    // Send a progress event.
    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: {'x-request-id': job.params['x-request-id']},
        url: vmapiUrl
    });
    var progressUrl = '/migrations/' + job.params.vm_uuid + '/progress';
    var event = {
        current_progress: 95,
        message: 'starting the original instance',
        phase: 'switch',
        state: 'running',
        total_progress: 100,
        type: 'progress'
    };
    rawVmapi.post(progressUrl, event, function _onNotifyProgressCb(err) {
        if (err) {
            job.log.warn({err: err, event: event},
                'Unable to notify progress event: ' + err);
        }
        // Intentionally no callback here (fire and forget).
    });

    // Start the source VM.
    var record = job.params.migrationTask.record;

    assert.uuid(record.vm_uuid, 'record.vm_uuid');

    var vmapi = new sdcClients.VMAPI({
        headers: {'x-request-id': job.params['x-request-id']},
        url: vmapiUrl
    });

    // Ensure that the initial state was running.
    if (job.params.vm.state !== 'running') {
        cb(null, 'OK - initial vm state was not running, state: ' +
            job.params.vm.state);
        return;
    }

    vmapi.startVm({uuid: record.vm_uuid}, function (err, body) {
        if (err) {
            cb(err);
            return;
        }

        // Set the workflow job uuid for the waitForWorkflowJob step.
        job.workflow_job_uuid = body.job_uuid;

        cb(null, 'OK - vm start workflow running, job uuid: ' + body.job_uuid);
    });
}


module.exports = {
    tasks: {
        disableSourceVmAutoboot: {
            name: 'migration.rollback.disableSourceVmAutoboot',
            timeout: 300,
            // retry: 1,
            body: disableSourceVmAutoboot,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        ensureSourceVmStopped: {
            name: 'migration.switch.ensureSourceVmStopped',
            timeout: 180,
            // retry: 1,
            body: ensureSourceVmStopped,
            modules: {
                sdcClients: 'sdc-clients'
            }
        },
        getRecord: {
            name: 'migration.switch.getRecord',
            timeout: 180,
            // retry: 1,
            body: getRecord,
            modules: {
                restify: 'restify'
            }
        },
        recordServerDetails: {
            name: 'migration.switch.recordServerDetails',
            timeout: 60,
            retry: 1,
            body: recordServerDetails,
            modules: {
            }
        },
        removeSourceSnapshots: {
            name: 'migration.switch.removeSourceSnapshots',
            timeout: 300,
            // retry: 1,
            body: removeSourceSnapshots,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        removeTargetDoNotInventory: {
            name: 'migration.switch.removeTargetDoNotInventory',
            timeout: 300,
            // retry: 1,
            body: removeTargetDoNotInventory,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        removeTargetSnapshots: {
            name: 'migration.switch.removeTargetSnapshots',
            timeout: 300,
            // retry: 1,
            body: removeTargetSnapshots,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        reserveNetworkIps: {
            name: 'migration.switch.reserveNetworkIps',
            timeout: 300,
            // retry: 1,
            body: reserveNetworkIps,
            modules: {
                restify: 'restify',
                sdcClients: 'sdc-clients',
                vasync: 'vasync'
            }
        },
        restoreIndestructibleZoneroot: {
            name: 'migration.switch.restoreIndestructibleZoneroot',
            timeout: 300,
            // retry: 1,
            body: restoreIndestructibleZoneroot,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        restoreIndestructibleDelegated: {
            name: 'migration.switch.restoreIndestructibleDelegated',
            timeout: 300,
            // retry: 1,
            body: restoreIndestructibleDelegated,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        setSourceDoNotInventory: {
            name: 'migration.switch.setSourceDoNotInventory',
            timeout: 300,
            // retry: 1,
            body: setSourceDoNotInventory,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        setupTargetFilesystem: {
            name: 'migration.switch.setupTargetFilesystem',
            timeout: 300,
            // retry: 1,
            body: setupTargetFilesystem,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        setTargetVmAutoboot: {
            name: 'migration.switch.setTargetVmAutoboot',
            timeout: 300,
            // retry: 1,
            body: setTargetVmAutoboot,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        startFinalSync: {
            name: 'migration.switch.startFinalSync',
            timeout: 300,
            // retry: 1,
            body: startFinalSync,
            modules: {
                restify: 'restify'
            }
        },
        startSourceVm: {
            name: 'migration.switch.startSourceVm',
            timeout: 300,
            // retry: 1,
            body: startSourceVm,
            modules: {
                assert: 'assert-plus',
                restify: 'restify',
                sdcClients: 'sdc-clients'
            }
        },
        startTargetVm: {
            name: 'migration.switch.startTargetVm',
            timeout: 300,
            // retry: 1,
            body: startTargetVm,
            modules: {
                assert: 'assert-plus',
                restify: 'restify',
                sdcClients: 'sdc-clients'
            }
        },
        stopSourceVm: {
            name: 'migration.switch.stopSourceVm',
            timeout: 300,
            // retry: 1,
            body: stopSourceVm,
            modules: {
                assert: 'assert-plus',
                restify: 'restify',
                sdcClients: 'sdc-clients'
            }
        },
        storeReservedNetworkIps: {
            name: 'migration.switch.storeReservedNetworkIps',
            timeout: 180,
            retry: 1,
            body: storeReservedNetworkIps,
            modules: {
                restify: 'restify'
            }
        },
        unreserveNetworkIps: {
            name: 'migration.switch.unreserveNetworkIps',
            timeout: 300,
            // retry: 1,
            body: unreserveNetworkIps,
            modules: {
               sdcClients: 'sdc-clients',
                vasync: 'vasync'
            }
        },
        updateVmServerUuid: {
            name: 'migration.switch.updateVmServerUuid',
            timeout: 300,
            // retry: 1,
            body: updateVmServerUuid,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        }
    }
};
