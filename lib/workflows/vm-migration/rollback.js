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
var vasync = require('vasync');


function ensureSourceVmHasDni(job, cb) {
    var record = job.params.migrationTask.record;

    assert.uuid(record.vm_uuid, 'record.vm_uuid');
    assert.uuid(record.source_server_uuid, 'record.source_server_uuid');

    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: {'x-request-id': job.params['x-request-id']}
    });

    var url = '/servers/' +
        record.source_server_uuid + '/vms/' +
        record.vm_uuid + '?include_dni=true';

    cnapi.get(url, function _cnapiGetSourceDniVmCb(err, req, res, vm) {
        if (err) {
            cb(err);
            return;
        }

        if (!vm.do_not_inventory) {
            cb('Source instance does not have the do_not_inventory flag');
            return;
        }

        cb(null, 'OK - source instance exists and has do_not_inventory flag');
    });
}


function stopTargetVm(job, cb) {
    var record = job.params.migrationTask.record;

    assert.uuid(record.target_server_uuid, 'record.target_server_uuid');
    assert.uuid(record.target_vm_uuid, 'record.target_vm_uuid');

    job.workflow_job_uuid = null;

    if (job.params.vm.state === 'stopped') {
        cb(null, 'OK - target vm is stopped already');
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
        current_progress: 3,
        message: 'stopping the instance',
        phase: 'rollback',
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

    vasync.pipeline({funcs: [
        function checkTargetVm(ctx, next) {
            var cnapi = restify.createJsonClient({
                url: cnapiUrl,
                headers: {'x-request-id': job.params['x-request-id']}
            });

            var url = '/servers/' +
                record.target_server_uuid + '/vms/' +
                record.target_vm_uuid + '?include_dni=true';

            cnapi.get(url, function _cnapiGetSourceDniVmCb(err, req, res, vm) {
                if (err) {
                    next(err);
                    return;
                }

                if (vm.do_not_inventory) {
                    // Target already has DNI set, remember that.
                    job.params.migrationTask.targetAlreadyHasDNI = true;
                    if (vm.state !== 'stopped') {
                        next('Target has DNI, yet state is not stopped: ' +
                            vm.state);
                        return;
                    }
                }
                next();
            });
        },

        function stopVm(ctx, next) {
            if (job.params.migrationTask.targetAlreadyHasDNI) {
                next();
                return;
            }

            var vmapi = new sdcClients.VMAPI({
                log: job.log,
                headers: {'x-request-id': job.params['x-request-id']},
                url: vmapiUrl
            });
            vmapi.stopVm({uuid: record.target_vm_uuid}, function (err, body) {
                if (err) {
                    next(err);
                    return;
                }

                // Set the workflow job uuid for the waitForWorkflowJob step.
                job.workflow_job_uuid = body.job_uuid;
                assert.uuid(job.workflow_job_uuid, 'job.workflow_job_uuid');

                next(null, 'OK - target vm stop called, job uuid: ' +
                    body.job_uuid);
            });
        }
    ]}, cb);
}


function ensureTargetVmStopped(job, cb) {
    var record = job.params.migrationTask.record;

    assert.uuid(record.target_server_uuid, 'record.target_server_uuid');
    assert.uuid(record.target_vm_uuid, 'record.target_vm_uuid');

    if (job.params.migrationTask.targetAlreadyHasDNI) {
        cb(null, 'OK - target VM already has DNI set');
        return;
    }

    var vmapi = new sdcClients.VMAPI({
        headers: {'x-request-id': job.params['x-request-id']},
        url: vmapiUrl
    });

    vmapi.getVm({uuid: record.target_vm_uuid}, function (err, vm) {
        if (err) {
            cb(err);
            return;
        }

        if (vm.state !== 'stopped') {
            cb(new Error('Vm is no longer stopped - state: ' + vm.state));
            return;
        }

        // job.vmStooped is required by the reserveNetworkIps task.
        job.vmStopped = vm;

        cb(null, 'OK - target vm is stopped');
    });
}


function setTargetDoNotInventory(job, cb) {
    var record = job.params.migrationTask.record;

    assert.uuid(record.target_server_uuid, 'record.target_server_uuid');
    assert.uuid(record.target_vm_uuid, 'record.target_vm_uuid');

    if (job.params.migrationTask.targetAlreadyHasDNI) {
        job.params.skip_zone_action = true;
        cb(null, 'OK - target VM already has DNI set');
        return;
    }

    // Send a progress event.
    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: {'x-request-id': job.params['x-request-id']},
        url: vmapiUrl
    });
    var progressUrl = '/migrations/' + job.params.target_vm_uuid + '/progress';
    var event = {
        current_progress: 25,
        message: 'hiding the target instance',
        phase: 'rollback',
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

    // Set DNI flag on the target instance.
    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });
    var url = '/servers/' +
        record.target_server_uuid + '/vms/' +
        record.target_vm_uuid + '/migrate';
    var payload = {
        action: 'set-do-not-inventory',
        migrationTask: job.params.migrationTask,
        vm_uuid: record.target_vm_uuid,
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


function removeSourceDoNotInventory(job, cb) {
    // Send a progress event.
    var rawVmapi = restify.createJsonClient({
        log: job.log,
        headers: {'x-request-id': job.params['x-request-id']},
        url: vmapiUrl
    });
    var progressUrl = '/migrations/' + job.params.vm_uuid + '/progress';
    var event = {
        current_progress: 85,
        message: 'promoting the original instance',
        phase: 'rollback',
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


function removeTargetIndestructibleZoneroot(job, cb) {
    var record = job.params.migrationTask.record;

    assert.object(job.params.vm, 'job.params.vm');
    assert.uuid(record.target_server_uuid, 'record.target_server_uuid');
    assert.uuid(record.target_vm_uuid, 'record.target_vm_uuid');

    if (!job.params.vm.indestructible_zoneroot) {
        job.params.skip_zone_action = true;
        cb(null, 'OK - indestructible_zoneroot is not set');
        return;
    }

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
        value: 'false'
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


function removeTargetIndestructibleDelegated(job, cb) {
    var record = job.params.migrationTask.record;

    assert.object(job.params.vm, 'job.params.vm');
    assert.uuid(record.target_server_uuid, 'record.target_server_uuid');
    assert.uuid(record.target_vm_uuid, 'record.target_vm_uuid');

    if (!job.params.vm.indestructible_delegated) {
        job.params.skip_zone_action = true;
        cb(null, 'OK - indestructible_delegated is not set');
        return;
    }

    // Set indestructible_delegated on the target instance.
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
        value: 'false'
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


function updateVmServerUuid(job, cb) {
    var record = job.params.migrationTask.record;

    assert.uuid(record.source_server_uuid, 'record.source_server_uuid');
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
        server_uuid: record.source_server_uuid
    };

    rawVmapi.post(url, data, function _updateVmServerUuidCb(err) {
        if (err) {
            job.log.error({err: err},
                'Unable to rollback vm server_uuid: ' + err);
            cb(err);
            return;
        }

        cb(null, 'OK - updated vm server uuid');
    });
}


function disableTargetVmAutoboot(job, cb) {
    var record = job.params.migrationTask.record;

    if (job.params.vm.autoboot === false) {
        job.params.skip_zone_action = true;
        cb(null, 'OK - autoboot is already disabled');
        return;
    }

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


function deleteTargetDniVm(job, cb) {
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
        current_progress: 90,
        message: 'removing the migrated instance',
        phase: 'rollback',
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

    // Remove the target vm.
    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: {'x-request-id': job.params['x-request-id']}
    });

    var url = '/servers/' +
        record.target_server_uuid + '/vms/' +
        record.target_vm_uuid + '?include_dni=true';

    cnapi.del(url, function _cnapiDelTargetDniVmCb(err, req, res, task) {
        if (err) {
            cb(err);
            return;
        }

        job.taskId = task.id;
        cb(null, 'OK - task id: ' + task.id + ' queued to CNAPI!');
    });
}


module.exports = {
    tasks: {
        deleteTargetDniVm: {
            name: 'migration.rollback.deleteTargetDniVm',
            timeout: 180,
            // retry: 1,
            body: deleteTargetDniVm,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        disableTargetVmAutoboot: {
            name: 'migration.rollback.disableTargetVmAutoboot',
            timeout: 300,
            // retry: 1,
            body: disableTargetVmAutoboot,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        ensureSourceVmHasDni: {
            name: 'migration.rollback.ensureSourceVmHasDni',
            timeout: 180,
            // retry: 1,
            body: ensureSourceVmHasDni,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        ensureTargetVmStopped: {
            name: 'migration.rollback.ensureTargetVmStopped',
            timeout: 180,
            // retry: 1,
            body: ensureTargetVmStopped,
            modules: {
                assert: 'assert-plus',
                sdcClients: 'sdc-clients'
            }
        },
        removeSourceDoNotInventory: {
            name: 'migration.rollback.removeSourceDoNotInventory',
            timeout: 300,
            // retry: 1,
            body: removeSourceDoNotInventory,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        removeTargetIndestructibleZoneroot: {
            name: 'migration.rollback.removeTargetIndestructibleZoneroot',
            timeout: 300,
            // retry: 1,
            body: removeTargetIndestructibleZoneroot,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        removeTargetIndestructibleDelegated: {
            name: 'migration.rollback.removeTargetIndestructibleDelegated',
            timeout: 300,
            // retry: 1,
            body: removeTargetIndestructibleDelegated,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        setTargetDoNotInventory: {
            name: 'migration.rollback.setTargetDoNotInventory',
            timeout: 300,
            // retry: 1,
            body: setTargetDoNotInventory,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        stopTargetVm: {
            name: 'migration.rollback.stopTargetVm',
            timeout: 300,
            // retry: 1,
            body: stopTargetVm,
            modules: {
                assert: 'assert-plus',
                restify: 'restify',
                sdcClients: 'sdc-clients',
                vasync: 'vasync'
            }
        }
    }
};
