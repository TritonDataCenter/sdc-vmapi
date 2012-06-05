/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var restify = require('restify');
var assert = require('assert');
var uuid = require('node-uuid');

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
 * Intializes all workflows that ZAPI needs to be aware of.
 */
Wfapi.prototype.initWorkflows = function () {
    var self = this;

    self.workflows.forEach(function (wf) {
        self.getWorkflow(wf, function (err, auuid) {
            if (err)
                self.log.error('Error getting workflow "' + wf + '"', err);

            if (auuid) {
                self.log.debug('Workflow "' + wf + '" exists');
                self.uuids[wf] = auuid;
            } else {
                self.log.debug('"' + wf + '" workflow doesn\'t exist, ' +
                               'let\'s create it');
                self.createWorkflow(wf, function (aerr, buuid) {
                    if (aerr)
                        self.log.error('Could not find "' + wf +
                                       '" workflow', aerr);
                    else
                        self.uuids[wf] = buuid;
                });
            }
        });
    });
};



/*
 * Retrieves a workflow from WFAPI.
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
    var muuid = uuid();
    var job = req.params;

    job.target = '/provision-' + muuid;
    job.muuid = muuid;
    job.zonename = muuid;
    job.workflow = this.uuids['provision'];

    // APIs
    job.ufdsUrl = req.config.ufds.url;
    job.ufdsDn = req.config.ufds.bindDN;
    job.ufdsPassword = req.config.ufds.bindPassword;

    job.dapiUrl = req.config.dapi.url;

    job.napiUrl = req.config.napi.url;
    job.napiUsername = req.config.napi.username;
    job.napiPassword = req.config.napi.password;

    job.cnapiUrl = req.config.cnapi.url;

    this.client.post('/jobs', job, function (err, aReq, aRes, theJob) {
        if (err)
            return cb(err);

        assert.ok(theJob.uuid);
        assert.equal(theJob.execution, 'queued');
        return cb(null, muuid, theJob.uuid);
    });
};



/*
 * Queues a start job.
 */
Wfapi.prototype.createStartJob = function (req, cb) {
    var muuid = req.vm.uuid;
    var job = req.params;

    job.target = '/start-' + muuid;
    job.muuid = muuid;
    job.zonename = muuid;
    job.workflow = this.uuids['start'];
    job.server_uuid = req.vm.server_uuid;

    // APIs
    job.cnapiUrl = req.config.cnapi.url;

    this.client.post('/jobs', job, function (err, aReq, aRes, theJob) {
        if (err)
            return cb(err);

        assert.ok(theJob.uuid);
        assert.equal(theJob.execution, 'queued');
        return cb(null, theJob.uuid);
    });
};



/*
 * Queues a stop job.
 */
Wfapi.prototype.createStopJob = function (req, cb) {
    var muuid = req.vm.uuid;
    var job = req.params;

    job.target = '/stop-' + muuid;
    job.muuid = muuid;
    job.zonename = muuid;
    job.workflow = this.uuids['stop'];
    job.server_uuid = req.vm.server_uuid;

    // APIs
    job.cnapiUrl = req.config.cnapi.url;

    this.client.post('/jobs', job, function (err, aReq, aRes, theJob) {
        if (err)
            return cb(err);

        assert.ok(theJob.uuid);
        assert.equal(theJob.execution, 'queued');
        return cb(null, theJob.uuid);
    });
};



/*
 * Queues a reboot job.
 */
Wfapi.prototype.createRebootJob = function (req, cb) {
    var muuid = req.vm.uuid;
    var job = req.params;

    job.target = '/reboot-' + muuid;
    job.muuid = muuid;
    job.zonename = muuid;
    job.workflow = this.uuids['reboot'];
    job.server_uuid = req.vm.server_uuid;

    // APIs
    job.cnapiUrl = req.config.cnapi.url;

    this.client.post('/jobs', job, function (err, aReq, aRes, theJob) {
        if (err)
            return cb(err);

        assert.ok(theJob.uuid);
        assert.equal(theJob.execution, 'queued');
        return cb(null, theJob.uuid);
    });
};



/*
 * Queues a destroy job.
 */
Wfapi.prototype.createDestroyJob = function (req, cb) {
    var muuid = req.vm.uuid;
    var job = req.params;

    job.target = '/destroy-' + muuid;
    job.muuid = muuid;
    job.zonename = muuid;
    job.workflow = this.uuids['destroy'];
    job.server_uuid = req.vm.server_uuid;

    // APIs
    job.cnapiUrl = req.config.cnapi.url;

    this.client.post('/jobs', job, function (err, aReq, aRes, theJob) {
        if (err)
            return cb(err);

        assert.ok(theJob.uuid);
        assert.equal(theJob.execution, 'queued');
        return cb(null, theJob.uuid);
    });
};



/*
 * Queues an update job.
 */
Wfapi.prototype.createUpdateJob = function (req, params, cb) {
    var muuid = req.vm.uuid;
    var job = params;

    job.target = '/update-' + muuid;
    job.muuid = muuid;
    job.zonename = muuid;
    job.workflow = this.uuids['update'];
    job.server_uuid = req.vm.server_uuid;

    // APIs
    job.cnapiUrl = req.config.cnapi.url;

    this.client.post('/jobs', job, function (err, aReq, aRes, theJob) {
        if (err)
            return cb(err);

        assert.ok(theJob.uuid);
        assert.equal(theJob.execution, 'queued');
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
                    // console.log(JSON.stringify(toSend[i]));
                    theRes.write(JSON.stringify(toSend[i]));
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
