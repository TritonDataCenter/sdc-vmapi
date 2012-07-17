/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var uuid = require('node-uuid');
var common = require('./../common');

var WfClient = require('wf-client');


// Workflows

// Absolute path from the app
var WORKFLOW_PATH = './lib/workflows/';


/*
 * WFAPI Constructor
 */
function Wfapi(options) {
    this.log = options.log;
    options.path = WORKFLOW_PATH;

    this.client = new WfClient(options);
    this.client.initWorkflows();
}



/*
 * Queues a provision job.
 */
Wfapi.prototype.createProvisionJob = function (req, cb) {
    var self = this;
    var vm_uuid = uuid();
    var params = req.params;

    params.task = 'provision';
    params.target = '/provision-' + vm_uuid;
    params.vm_uuid = vm_uuid;

    self.client.createJob('provision', params, function (err, job) {
        if (err)
            return cb(err);

        self.log.debug('Provision job ' + params.uuid + ' queued for VM '
            + vm_uuid);
        return cb(null, vm_uuid, job.uuid);
    });
};



/*
 * Queues a start job.
 */
Wfapi.prototype.createStartJob = function (req, cb) {
    var self = this;
    var vm_uuid = req.vm.uuid;
    var params = req.params;

    params.task = 'start';
    params.target = '/start-' + vm_uuid;
    params.vm_uuid = vm_uuid;
    params.server_uuid = req.vm.server_uuid;

    self.client.createJob('start', params, function (err, job) {
        if (err)
            return cb(err);

        self.log.debug('Start job ' + job.uuid + ' queued for VM '
            + vm_uuid);
        return cb(null, job.uuid);
    });
};



/*
 * Queues a stop job.
 */
Wfapi.prototype.createStopJob = function (req, cb) {
    var self = this;
    var vm_uuid = req.vm.uuid;
    var params = req.params;

    params.task = 'stop';
    params.target = '/stop-' + vm_uuid;
    params.vm_uuid = vm_uuid;
    params.server_uuid = req.vm.server_uuid;

    self.client.createJob('stop', params, function (err, job) {
        if (err)
            return cb(err);

        self.log.debug('Stop job ' + job.uuid + ' queued for VM '
            + vm_uuid);
        return cb(null, job.uuid);
    });
};



/*
 * Queues a reboot job.
 */
Wfapi.prototype.createRebootJob = function (req, cb) {
    var self = this;
    var vm_uuid = req.vm.uuid;
    var params = req.params;

    params.task = 'reboot';
    params.target = '/reboot-' + vm_uuid;
    params.vm_uuid = vm_uuid;
    params.server_uuid = req.vm.server_uuid;

    self.client.createJob('reboot', params, function (err, job) {
        if (err)
            return cb(err);

        self.log.debug('Reboot job ' + job.uuid + ' queued for VM '
            + vm_uuid);
        return cb(null, job.uuid);
    });
};



/*
 * Queues a destroy job.
 */
Wfapi.prototype.createDestroyJob = function (req, cb) {
    var self = this;
    var vm_uuid = req.vm.uuid;
    var params = req.params;

    params.task = 'destroy';
    params.target = '/destroy-' + vm_uuid;
    params.vm_uuid = vm_uuid;
    params.server_uuid = req.vm.server_uuid;

    self.client.createJob('destroy', params, function (err, job) {
        if (err)
            return cb(err);

        self.log.debug('Destroy job ' + job.uuid + ' queued for VM '
            + vm_uuid);
        return cb(null, job.uuid);
    });
};



/*
 * Queues an update job.
 */
Wfapi.prototype.createUpdateJob = function (req, params, cb) {
    var self = this;
    var vm_uuid = req.vm.uuid;

    params.task = 'update';
    params.target = '/update-' + vm_uuid;
    params.vm_uuid = vm_uuid;
    params.server_uuid = req.vm.server_uuid;

    self.client.createJob('update', params, function (err, job) {
        if (err)
            return cb(err);

        self.log.debug('Update job ' + job.uuid + ' queued for VM '
            + vm_uuid);
        return cb(null, job.uuid);
    });
};



/*
 * Retrieves a job from WFAPI.
 */
Wfapi.prototype.getJob = function (uuid, cb) {
    this.client.getJob(uuid, function (err, job) {
        if (err)
            return cb(err);

        return cb(null, common.translateJob(job));
    });
};



/*
 * Lists jobs from WFAPI.
 */
Wfapi.prototype.listJobs = function (params, cb) {
    var query = {};

    if (params.execution)
        query.execution = params.execution;

    if (params.task)
        query.task = params.task;

    if (params.vm_uuid)
        query.vm_uuid = params.vm_uuid;

    this.client.listJobs(query, function (err, jobs) {
        if (err)
            return cb(err);

        var theJobs = [];
        for (var i = 0; i < jobs.length; i++) {
            theJobs.push(common.translateJob(jobs[i]));
        }

        return cb(null, theJobs);
    });
};



/*
 * Pipes job/info output to a http response
 * Experimental stuff.
 */
Wfapi.prototype.pipeJob = function (theRes, auuid, cb) {
    var self = this;
    var curLength = 0;

    var interval = setInterval(function () {
        self.client.getJob(auuid, function (err, job) {
            if (err)
                return cb(err);

            var newLength = job.chain_results.length;

            if (newLength > curLength) {
                var toSend = job.chain_results.slice(curLength, newLength);
                for (var i = 0; i < toSend.length; i++) {
                    var chunk = toSend[i];
                    chunk['job_uuid'] = job.uuid;
                    chunk['job_execution'] = job.execution;
                    theRes.write(JSON.stringify(chunk));
                }

                curLength = newLength;
            }

            if (job.execution == 'succeeded') {
                clearInterval(interval);
                return cb(null);
            } else if (job.execution == 'failed') {
                clearInterval(interval);
                return cb(new Error('Job execution failed'));
            }
        });
    }, 500);
};



module.exports = Wfapi;
