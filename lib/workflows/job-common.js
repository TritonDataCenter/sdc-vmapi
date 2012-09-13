/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


// This is not really needed, but javascriptlint will complain otherwise:
var sdcClients = require('sdc-clients');
var restify = require('restify');



function validateForZoneAction(job, cb) {
    if (!cnapiUrl)
        return cb('No CNAPI URL provided');

    if (!job.params['vm_uuid'])
        return cb('VM UUID is required');

    return cb(null, 'All parameters OK!');
}



function zoneAction(job, cb) {
    if (!job.endpoint)
        return cb('No CNAPI endpoint provided');

    if (!job.requestMethod)
        return cb('No HTTP request method provided');

    var cnapi = restify.createJsonClient({ url: cnapiUrl });

    function callback(err, req, res, task) {
        if (err) {
            return cb(err);
        } else {
            job.taskId = task.id;
            return cb(null, 'Task queued to CNAPI!');
        }
    }

    if (job.requestMethod == 'post')
        return cnapi.post(job.endpoint, job.params, callback);
    else if (job.requestMethod == 'del')
        return cnapi.del(job.endpoint, callback);
    else
        return cb('Unsupported requestMethod: "' + job.requestMethod + '"');
}



function pollTask(job, cb) {
    if (!job.taskId)
        return cb('No taskId provided');

    if (!cnapiUrl)
        return cb('No CNAPI URL provided');

    var cnapi = restify.createJsonClient({ url: cnapiUrl });

    // We have to poll the task until it completes. Ensure the timeout is
    // big enough so tasks end on time
    var intervalId = setInterval(interval, 1000);

    function interval() {
        function onCnapi(err, req, res, task) {
            if (err) {
                return cb(err);
            } else {
                if (task.status == 'failure') {
                    clearInterval(intervalId);
                    return cb('Job failed');

                } else if (task.status == 'complete') {
                    clearInterval(intervalId);
                    return cb(null, 'Job succeeded!');
                }
            }
        }

        cnapi.get('/tasks/' + job.taskId, onCnapi);
    }
}



function checkState(job, cb) {
    // For now don't fail the job if this parameter is not present
    if (!job.expects)
        return cb(null, 'No \'expects\' state parameter provided');

    if (!job.params['vm_uuid'])
        return cb('No VM UUID provided');

    if (!vmapiUrl)
        return cb('No VMAPI URL provided');

    var vmapi = restify.createJsonClient({ url: vmapiUrl });

    // Poll the VM until we reach to the desired state, otherwise the task
    // timeout will fail the job, which is what we want
    var path = '/vms/' + job.params['vm_uuid'];
    var intervalId = setInterval(interval, 1000);

    function interval() {
        function onVmapi(err, req, res, vm) {
            // Provision tasks can return 404 when machine has not showed up
            if (res && res.statusCode == 404 && job.params.task == 'provision') {
                return;
            } else if (err) {
                clearInterval(intervalId);
                return cb(err);
            } else {
                if (vm.state == job.expects) {
                    clearInterval(intervalId);
                    return cb(null, 'VM is now ' + job.expects);
                }
            }
        }

        vmapi.get(path, onVmapi);
    }
}



function checkPropagated(job, cb) {
    if (!job.params['vm_uuid'])
        return cb('No VM UUID provided');

    if (!vmapiUrl)
        return cb('No VMAPI URL provided');

    var vmapi = restify.createJsonClient({ url: vmapiUrl });

    // Poll the VM until its data has been propagated to UFDS
    var path = '/vms?uuid=' + job.params['vm_uuid'];
    var intervalId = setInterval(interval, 1000);

    function interval() {
        function onVmapi(err, req, res, vms) {
            if (err) {
                clearInterval(intervalId);
                return cb(err);
            } else if (vms.length && (vms[0].uuid == job.params['vm_uuid'])) {
                clearInterval(intervalId);
                return cb(null, 'VM data has been propagated');
            } else {
                return;
            }
        }

        vmapi.get(path, onVmapi);
    }
}



function checkUpdated(job, cb) {
    if (!job.params['vm_uuid'])
        return cb('No VM UUID provided');

    if (!vmapiUrl)
        return cb('No VMAPI URL provided');

    if (!job.params['last_modified'])
        return cb('No VM last_modified timestamp provided');

    var oldDate = new Date(job.params['last_modified']);
    var vmapi = restify.createJsonClient({ url: vmapiUrl });

    // Poll the VM until its last_modified timestamp has changed
    var path = '/vms?uuid=' + job.params['vm_uuid'];
    var intervalId = setInterval(interval, 1000);

    function interval() {
        function onVmapi(err, req, res, vms) {
            if (err) {
                clearInterval(intervalId);
                return cb(err);
            } else if (vms.length && (vms[0].uuid == job.params['vm_uuid'])) {
                var newDate = new Date(vms[0]['last_modified']);

                if (newDate > oldDate) {
                    clearInterval(intervalId);
                    return cb(null, 'VM data has been updated');
                }
            }
        }

        vmapi.get(path, onVmapi);
    }
}



module.exports = {
    validateForZoneAction: validateForZoneAction,
    zoneAction: zoneAction,
    pollTask: pollTask,
    checkState: checkState,
    checkPropagated: checkPropagated,
    checkUpdated: checkUpdated
};
