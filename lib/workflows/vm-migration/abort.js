/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */


var assert = require('assert-plus');
var restify = require('restify');


function ensureTargetVmHasDni(job, cb) {
    var record = job.params.migrationTask.record;

    assert.uuid(record.target_vm_uuid, 'record.target_vm_uuid');
    assert.uuid(record.target_server_uuid, 'record.target_server_uuid');

    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: {'x-request-id': job.params['x-request-id']}
    });

    var url = '/servers/' +
        record.target_server_uuid + '/vms/' +
        record.target_vm_uuid + '?include_dni=true';
    job.store_task_result_in_attribute = 'targetVm';

    cnapi.get(url, function _cnapiGetTargetDniVmCb(err, req, res, vm) {
        if (err) {
            if (err.statusCode === 404) {
                // Vm not found - okay that makes our job easier.
                cb(null, 'OK - target instance does not exist');
                return;
            }
            cb(err);
            return;
        }

        if (!vm.do_not_inventory) {
            cb('Target instance does not have the do_not_inventory flag');
            return;
        }

        cb(null, 'OK - target instance exists and has do_not_inventory flag');
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
        current_progress: 70,
        message: 'removing the reserved instance',
        phase: 'abort',
        state: 'running',
        total_progress: 100,
        type: 'progress'
    };
    rawVmapi.post(progressUrl, event, function _onNotifyProgressCb(err) {
        if (err) {
            job.log.warn({err: err, event: event},
                'Unable to notify progress event: ' + err);
        }
        // Intentially no callback here (fire and forget).
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
            name: 'migration.abort.deleteTargetDniVm',
            timeout: 180,
            // retry: 1,
            body: deleteTargetDniVm,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        ensureTargetVmHasDni: {
            name: 'migration.abort.ensureTargetVmHasDni',
            timeout: 180,
            // retry: 1,
            body: ensureTargetVmHasDni,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        }
    }
};
