/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


// This is not really needed, but javascriptlint will complain otherwise:
var sdcClients = require('sdc-clients');
var restify = require('restify');


// make check
var vmapiUrl, cnapiUrl;


/*
 * Validates that the request can be used to call CNAPI, i.e. that the cnapiUrl
 * and vm_uuid parameters are present
 */
function validateForZoneAction(job, cb) {
    if (!cnapiUrl) {
        cb('No CNAPI URL provided');
        return;
    }

    if (!job.params['vm_uuid']) {
        cb('VM UUID is required');
        return;
    }

    cb(null, 'All parameters OK!');
}



/*
 * General purpose function to call a CNAPI endpoint. endpoint and requestMethod
 * are required. This function will post the job params object as params for the
 * CNAPI request. Additionally, this function will set a taskId property in the
 * job object so you can optionally poll the status of the task with pollTask
 */
function zoneAction(job, cb) {
    if (job.params['skip_boot']) {
        cb(null, 'Skipping zoneAction');
        return;
    }

    if (!job.endpoint) {
        cb('No CNAPI endpoint provided');
        return;
    }

    if (!job.requestMethod) {
        cb('No HTTP request method provided');
        return;
    }

    var cnapi = restify.createJsonClient({ url: cnapiUrl });

    function callback(err, req, res, task) {
        if (err) {
            cb(err);
        } else {
            job.taskId = task.id;
            cb(null, 'Task queued to CNAPI!');
        }
    }

    if (job.requestMethod == 'post') {
        cnapi.post(job.endpoint, job.params, callback);
    } else if (job.requestMethod == 'del') {
        cnapi.del(job.endpoint, callback);
    } else {
        cb('Unsupported requestMethod: "' + job.requestMethod + '"');
    }
}



/*
 * Polls the status of a CNAPI task. The two possible final states of a task
 * are failure and completed. taskId is required for this task, so this function
 * is commonly used in conjunction with zoneAction
 */
function pollTask(job, cb) {
    if (job.params['skip_boot']) {
        cb(null, 'Skipping pollTask');
        return;
    }

    if (!job.taskId) {
        cb('No taskId provided');
        return;
    }

    if (!cnapiUrl) {
        cb('No CNAPI URL provided');
        return;
    }

    var cnapi = restify.createJsonClient({ url: cnapiUrl });

    // We have to poll the task until it completes. Ensure the timeout is
    // big enough so tasks end on time
    var intervalId = setInterval(interval, 1000);

    function interval() {
        function onCnapi(err, req, res, task) {
            if (err) {
                cb(err);
            } else {
                if (task.status == 'failure') {
                    clearInterval(intervalId);
                    cb('Job failed');

                } else if (task.status == 'complete') {
                    clearInterval(intervalId);
                    cb(null, 'Job succeeded!');
                }
            }
        }

        cnapi.get('/tasks/' + job.taskId, onCnapi);
    }
}



/*
 * Checks (polls) the state of a machine in VMAPI. It is used for provisions and VM
 * actions such as reboot and shutdown. This task will only succeed if the VM
 * reaches the expected state, which can be passed as job.expects on a previous
 * task. vm_uuid and vmapiUrl are also required
 */
function checkState(job, cb) {
    if (job.params['skip_boot']) {
        cb(null, 'Skipping checkState');
        return;
    }

    // For now don't fail the job if this parameter is not present
    if (!job.expects) {
        cb(null, 'No \'expects\' state parameter provided');
        return;
    }

    if (!job.params['vm_uuid']) {
        cb('No VM UUID provided');
        return;
    }

    if (!vmapiUrl) {
        cb('No VMAPI URL provided');
        return;
    }

    var vmapi = restify.createJsonClient({ url: vmapiUrl });

    // Poll the VM until we reach to the desired state, otherwise the task
    // timeout will fail the job, which is what we want
    var path = '/vms/' + job.params['vm_uuid'];
    var intervalId = setInterval(interval, 1000);

    function interval() {
        vmapi.get(path, onVmapi);

        function onVmapi(err, req, res, vm) {
            // Provision tasks can return 404 when machine has not showed up
            if (res && res.statusCode == 404 &&
                job.params.task == 'provision') {
                return;
            } else if (err) {
                clearInterval(intervalId);
                cb(err);
            } else {
                if (vm.state == job.expects) {
                    clearInterval(intervalId);
                    cb(null, 'VM is now ' + job.expects);
                }
            }
            return;
        }
    }
}



/*
 * Checks (polls) that the VM data has been propagated to the data store. It
 * calls /vms instead of /vms/uuid, thus forcing vmapi to read from the data
 * store directly and not the 'provisioning cache'
 */
function checkPropagated(job, cb) {
    if (!job.params['vm_uuid']) {
        cb('No VM UUID provided');
        return;
    }

    if (!vmapiUrl) {
        cb('No VMAPI URL provided');
        return;
    }

    var vmapi = restify.createJsonClient({ url: vmapiUrl });

    // Poll the VM until its data has been propagated to moray
    var path = '/vms?uuid=' + job.params['vm_uuid'];
    var intervalId = setInterval(interval, 1000);

    function interval() {
        function onVmapi(err, req, res, vms) {
            if (err) {
                clearInterval(intervalId);
                cb(err);
            } else if (vms.length && (vms[0].uuid == job.params['vm_uuid'])) {
                clearInterval(intervalId);
                cb(null, 'VM data has been propagated');
            }
        }

        vmapi.get(path, onVmapi);
    }
}



/*
 * Checks (polls) that the machine has been updated at all. When any of the VM
 * properties are updated (such as ram or metadata), the last_modified timestamp
 * of the VM changes. This let us poll the VM endpoint until the changes on its
 * properties have been propagated
 */
function checkUpdated(job, cb) {
    if (!job.params['vm_uuid']) {
        cb('No VM UUID provided');
        return;
    }

    if (!vmapiUrl) {
        cb('No VMAPI URL provided');
        return;
    }

    if (!job.params['last_modified']) {
        cb('No VM last_modified timestamp provided');
        return;
    }

    var oldDate = new Date(job.params['last_modified']);
    var vmapi = restify.createJsonClient({ url: vmapiUrl });

    // Poll the VM until its last_modified timestamp has changed
    var path = '/vms?uuid=' + job.params['vm_uuid'];
    var intervalId = setInterval(interval, 1000);

    function interval() {
        vmapi.get(path, onVmapi);

        function onVmapi(err, req, res, vms) {
            if (err) {
                clearInterval(intervalId);
                cb(err);
            } else if (vms.length && (vms[0].uuid == job.params['vm_uuid'])) {
                var newDate = new Date(vms[0]['last_modified']);

                if (newDate > oldDate) {
                    clearInterval(intervalId);
                    cb(null, 'VM data has been updated');
                }
            }
        }
    }
}



/*
 * Deletes a custom vmusage object from UFDS. This object is used by the cloudapi
 * limits plugin in order to determine if a customer should be able to provision
 * more machines
 */
function deleteCustomerVm(job, cb) {
    // This allows the provisioning task to know if the customer was added to
    // UFDS already before the provision failed so we don't try to destroy a
    // customer that doesn't exist
    if (!job.addedToUfds) {
        return cb(null, 'Customer doesn\'t exist on UFDS');
    }

    var dn = 'vm=' + job.params['vm_uuid'] + ', uuid=' +
            job.params['owner_uuid'] + ', ou=users, o=smartdc';

    var ufdsOptions = {
        url: ufdsUrl,
        bindDN: ufdsDn,
        bindPassword: ufdsPassword
    };

    var UFDS = new sdcClients.UFDS(ufdsOptions);

    UFDS.on('ready', deleteVm);
    UFDS.on('error', function (err) {
        return cb(err);
    });

    function deleteVm() {
        return UFDS.del(dn, function (err) {
            if (err) {
                return cb(err);
            }

            return cb(null, 'Customer VM usage deleted from UFDS');
        });
    }
}



module.exports = {
    validateForZoneAction: validateForZoneAction,
    zoneAction: zoneAction,
    pollTask: pollTask,
    checkState: checkState,
    checkPropagated: checkPropagated,
    checkUpdated: checkUpdated,
    deleteCustomerVm: deleteCustomerVm
};
