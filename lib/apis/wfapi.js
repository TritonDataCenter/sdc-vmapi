/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var restify = require('restify');
var assert = require('assert');
var uuid = require('node-uuid');
var common = require('./../common');


// Workflows

var WORKFLOW_PATH = '../workflows/';


/*
 * WFAPI Constructor
 */
function Wfapi(options) {
    this.log = options.log;

    this.client = restify.createJsonClient({
        url: options.url,
        version: '*',
        retryOptions: {
            retry: 0
        },
        log: options.log
    });

    this.workflows = options.workflows || [];
    this.uuids = {};
}



/*
 * Intializes all workflows that VMAPI needs to be aware of.
 */
Wfapi.prototype.initWorkflows = function () {
    var self = this;

    self.workflows.forEach(function (wf) {
        self.getOrCreateWorkflow(wf);
    });
};



/*
 * Gets or Creates a workflow. A new workflow is created when there is none
 * yet or when we want to replace an existing one
 */
Wfapi.prototype.getOrCreateWorkflow = function (wf) {
    var self = this;

    // Will load something like provision.js
    // The workflow now wil be name-file.version or file.name if version
    // was not given.
    var file = require(WORKFLOW_PATH + wf);
    var wfName = (wf + '-' + file.version) || file.name;


    self.getWorkflow(wfName, function (err, auuid) {
        if (err) {
            self.log.error('Error getting workflow ' + wfName, err);
        } else if (auuid) {
            self.log.debug(wfName + ' workflow exists');
            self.uuids[wf] = auuid;
        } else {
            self.createWorkflow(wf, function (aerr, buuid) {
                if (aerr) {
                    self.log.error('Error adding ' + wfName, aerr);
                } else {
                    self.log.debug(wfName + ' workflow added');
                    self.uuids[wf] = buuid;
                }
            });
        }
    });
};



/*
 * Retrieves a workflow by name from WFAPI.
 */
Wfapi.prototype.getWorkflow = function (name, cb) {
    this.client.get('/workflows', function (err, req, res, wfs) {
        if (err)
            return cb(err);

        if (!wfs.length)
            return cb(null, null);

        for (var i = 0; i < wfs.length; i++) {
            var wf = wfs[i];

            if (wf.name.indexOf(name) != -1)
                return cb(null, wf.uuid);
        }

        return cb(null, null);
    });
};



/*
 * Creates a workflow on WFAPI. Currently only works with a provision workflow,
 * which means that the function doesn't take any workflow as an argument yet
 */
Wfapi.prototype.createWorkflow = function (name, cb) {
    var self = this;
    var file = require(WORKFLOW_PATH + name);

    var serialized = self.serializeWorkflow(file);

    self.client.post('/workflows', serialized, function (err, req, res, wf) {
        if (err)
            return cb(err);

        return cb(null, wf.uuid);
    });
};



/*
 * Serializes a workflow object. This function is basically converting object
 * properties that are functions into strings, so they can be properly
 * represented as JSON
 */
Wfapi.prototype.serializeWorkflow = function (wf) {
    var i;

    if (wf.chain.length) {
        for (i = 0; i < wf.chain.length; i++) {
            if (wf.chain[i].body)
                wf.chain[i].body = wf.chain[i].body.toString();

            if (wf.chain[i].fallback)
                wf.chain[i].fallback = wf.chain[i].fallback.toString();
        }
    }


    if (wf.onerror.length) {
        for (i = 0; i < wf.onerror.length; i++) {
            if (wf.onerror[i].body)
                wf.onerror[i].body = wf.onerror[i].body.toString();
      }
    }

    return wf;
};



/*
 * Queues a provision job.
 */
Wfapi.prototype.createProvisionJob = function (req, cb) {
    var self = this;
    var vm_uuid = uuid();
    var job = req.params;

    job.task = 'provision';
    job.target = '/provision-' + vm_uuid;
    job.vm_uuid = vm_uuid;
    job.zonename = vm_uuid;
    job.workflow = this.uuids['provision'];
    job.expects = 'running';

    // APIs
    job['ufds_url'] = req.config.ufds.url;
    job['ufds_dn'] = req.config.ufds.bindDN;
    job['ufds_password'] = req.config.ufds.bindPassword;

    job['dapi_url'] = req.config.dapi.url;

    job['napi_url'] = req.config.napi.url;
    job['napi_username'] = req.config.napi.username;
    job['napi_password'] = req.config.napi.password;

    job['cnapi_url'] = req.config.cnapi.url;
    job['vmapi_url'] = req.config.api.url;

    this.client.post('/jobs', job, function (err, aReq, aRes, theJob) {
        if (err)
            return cb(err);

        assert.ok(theJob.uuid);
        assert.equal(theJob.execution, 'queued');
        self.log.debug('Provision job ' + theJob.uuid + ' queued for VM '
            + vm_uuid);
        return cb(null, vm_uuid, theJob.uuid);
    });
};



/*
 * Queues a start job.
 */
Wfapi.prototype.createStartJob = function (req, cb) {
    var self = this;
    var vm_uuid = req.vm.uuid;
    var job = req.params;

    job.task = 'start';
    job.target = '/start-' + vm_uuid;
    job.vm_uuid = vm_uuid;
    job.zonename = vm_uuid;
    job.workflow = this.uuids['start'];
    job.server_uuid = req.vm.server_uuid;
    job.expects = 'running';

    // APIs
    job['cnapi_url'] = req.config.cnapi.url;
    job['vmapi_url'] = req.config.api.url;

    this.client.post('/jobs', job, function (err, aReq, aRes, theJob) {
        if (err)
            return cb(err);

        assert.ok(theJob.uuid);
        assert.equal(theJob.execution, 'queued');
        self.log.debug('Start job ' + theJob.uuid + ' queued for VM '
            + vm_uuid);
        return cb(null, theJob.uuid);
    });
};



/*
 * Queues a stop job.
 */
Wfapi.prototype.createStopJob = function (req, cb) {
    var self = this;
    var vm_uuid = req.vm.uuid;
    var job = req.params;

    job.task = 'stop';
    job.target = '/stop-' + vm_uuid;
    job.vm_uuid = vm_uuid;
    job.zonename = vm_uuid;
    job.workflow = this.uuids['stop'];
    job.server_uuid = req.vm.server_uuid;
    job.expects = 'stopped';

    // APIs
    job['cnapi_url'] = req.config.cnapi.url;
    job['vmapi_url'] = req.config.api.url;

    this.client.post('/jobs', job, function (err, aReq, aRes, theJob) {
        if (err)
            return cb(err);

        assert.ok(theJob.uuid);
        assert.equal(theJob.execution, 'queued');
        self.log.debug('Stop job ' + theJob.uuid + ' queued for VM '
            + vm_uuid);
        return cb(null, theJob.uuid);
    });
};



/*
 * Queues a reboot job.
 */
Wfapi.prototype.createRebootJob = function (req, cb) {
    var self = this;
    var vm_uuid = req.vm.uuid;
    var job = req.params;

    job.task = 'reboot';
    job.target = '/reboot-' + vm_uuid;
    job.vm_uuid = vm_uuid;
    job.zonename = vm_uuid;
    job.workflow = this.uuids['reboot'];
    job.server_uuid = req.vm.server_uuid;
    job.expects = 'running';

    // APIs
    job['cnapi_url'] = req.config.cnapi.url;
    job['vmapi_url'] = req.config.api.url;

    this.client.post('/jobs', job, function (err, aReq, aRes, theJob) {
        if (err)
            return cb(err);

        assert.ok(theJob.uuid);
        assert.equal(theJob.execution, 'queued');
        self.log.debug('Reboot job ' + theJob.uuid + ' queued for VM '
            + vm_uuid);
        return cb(null, theJob.uuid);
    });
};



/*
 * Queues a destroy job.
 */
Wfapi.prototype.createDestroyJob = function (req, cb) {
    var self = this;
    var vm_uuid = req.vm.uuid;
    var job = req.params;

    job.task = 'destroy';
    job.target = '/destroy-' + vm_uuid;
    job.vm_uuid = vm_uuid;
    job.zonename = vm_uuid;
    job.workflow = this.uuids['destroy'];
    job.server_uuid = req.vm.server_uuid;
    job.expects = 'destroyed';

    // APIs
    job['cnapi_url'] = req.config.cnapi.url;
    job['vmapi_url'] = req.config.api.url;

    this.client.post('/jobs', job, function (err, aReq, aRes, theJob) {
        if (err)
            return cb(err);

        assert.ok(theJob.uuid);
        assert.equal(theJob.execution, 'queued');
        self.log.debug('Destroy job ' + theJob.uuid + ' queued for VM '
            + vm_uuid);
        return cb(null, theJob.uuid);
    });
};



/*
 * Queues an update job.
 */
Wfapi.prototype.createUpdateJob = function (req, params, cb) {
    var self = this;
    var vm_uuid = req.vm.uuid;
    var job = params;

    job.task = 'update';
    job.target = '/update-' + vm_uuid;
    job.vm_uuid = vm_uuid;
    job.zonename = vm_uuid;
    job.workflow = this.uuids['update'];
    job.server_uuid = req.vm.server_uuid;
    job.expects = 'running';

    // APIs
    job['cnapi_url'] = req.config.cnapi.url;
    job['vmapi_url'] = req.config.api.url;

    this.client.post('/jobs', job, function (err, aReq, aRes, theJob) {
        if (err)
            return cb(err);

        assert.ok(theJob.uuid);
        assert.equal(theJob.execution, 'queued');
        self.log.debug('Update job ' + theJob.uuid + ' queued for VM '
            + vm_uuid);
        return cb(null, theJob.uuid);
    });
};



/*
 * Retrieves a job from WFAPI.
 */
Wfapi.prototype.getJob = function (auuid, cb) {
    this.client.get('/jobs/' + auuid, function (err, req, res, job) {
        if (err)
            return cb(err);

        return cb(null, job);
    });
};



/*
 * Lists jobs from WFAPI.
 */
Wfapi.prototype.listJobs = function (params, cb) {
    var getParams = { path: '/jobs' };
    var query = {};

    if (params.execution)
        query.execution = params.execution;

    if (params.task)
        query.task = params.task;

    if (params.vm_uuid)
        query.vm_uuid = params.vm_uuid;

    getParams.query = query;

    this.client.get(getParams, function (err, req, res, jobs) {
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
        self.getJob(auuid, function (err, job) {
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
