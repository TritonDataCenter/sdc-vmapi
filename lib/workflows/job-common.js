/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


// This is not really needed, but javascriptlint will complain otherwise:
var sdcClients = require('sdc-clients');
var uuid = require('node-uuid');
var restify = require('restify');



function validateForZoneAction(job, cb) {
    if (!job.params['cnapi_url'])
        return cb('No CNAPI URL provided');

    if (!job.params.vm_uuid)
        return cb('VM UUID is required');

    return cb(null, 'All parameters OK!');
}



function zoneAction(job, cb) {
    if (!job.endpoint)
        return cb('No CNAPI endpoint provided');

    if (!job.requestMethod)
        return cb('No HTTP request method provided');

    var cnapi = restify.createJsonClient({ url: job.params['cnapi_url'] });

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

    if (!job.params['cnapi_url'])
        return cb('No CNAPI URL provided');

    var cnapi = restify.createJsonClient({ url: job.params['cnapi_url'] });

    // We have to poll the task until it completes. Ensure the timeout is
    // big enough so tasks end on time
    var intervalId = setInterval(function () {
        cnapi.get('/tasks/' + job.taskId, function (err, req, res, task) {
            if (err) {
                return cb(err);
            } else {
                if (task.status == 'failure') {
                    clearInterval(intervalId);
                    cb('Job failed');
                    return;

                } else if (task.status == 'complete') {
                    clearInterval(intervalId);
                    cb(null, 'Job succeeded!');
                    return;
                }
            }
        });
    }, 1000);
}



function checkState(job, cb) {
    // For now don't fail the job if this parameter is not present
    if (!job.params.expects)
        return cb(null, 'No \'expects\' state parameter provided');

    if (!job.params['vm_uuid'])
        return cb('No VM UUID provided');

    if (!job.params['vmapi_url'])
        return cb('No VMAPI URL provided');

    var vmapi = restify.createJsonClient({ url: job.params['vmapi_url'] });

    // Poll the VM until we reach to the desired state, otherwise the task
    // timeout will fail the job, which is what we want
    var path = '/vms/' + job.params['vm_uuid'];
    var intervalId = setInterval(function () {
        vmapi.get(path, function (err, req, res, vm) {
            if (err) {
                return cb(err);
            } else {
                if (vm.state == job.params.expects) {
                    clearInterval(intervalId);
                    cb(null, 'VM is now ' + job.params.expects);
                    return;
                }
            }
        });
    }, 1000);
}



module.exports = {
    validateForZoneAction: validateForZoneAction,
    zoneAction: zoneAction,
    pollTask: pollTask,
    checkState: checkState
};
