/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var restify = require('restify');
var assert = require('assert');


/*
 * WfClient Constructor
 */
function WfClient(options) {
    if (!options || typeof (options) !== 'object')
        throw new TypeError('options is required (object)');
    if (!options.url)
        throw new TypeError('url is required (string)');
    if (!options.path)
        throw new TypeError('path is required (string)');
    if (!options.log)
        throw new TypeError('log is required (bunyan Logger instance)');

    this.client = restify.createJsonClient({
        url: options.url,
        version: '*',
        retryOptions: {
            retry: 0
        },
        log: options.log
    });

    this.log = options.log;
    this.path = options.path;
    this.workflows = options.workflows || [];
    this.uuids = {};
}



/*
 * Intializes all workflows that a client needs to be aware of.
 */
WfClient.prototype.initWorkflows = function () {
    var self = this;

    self.workflows.forEach(function (wf) {
        self.loadWorkflow(wf);
    });
};



/*
 * Loads a workflow. A new workflow is created when there is none
 * yet or when we want to replace an existing one
 */
WfClient.prototype.loadWorkflow = function (wf) {
    var self = this;

    // Will load something like provision.js
    // The workflow now wil be name-file.version or file.name if version
    // was not given.
    var file = require(this.path + wf);
    var wfName = (wf + '-' + file.version) || file.name;


    self.findWorkflow(wfName, function (err, obj) {
        if (err) {
            self.log.error('Error getting workflow ' + wfName, err);
        } else if (obj) {
            self.log.debug(wfName + ' workflow exists');
            self.uuids[wf] = obj.uuid;
        } else {
            self.createWorkflow(wf, function (aerr, uuid) {
                if (aerr) {
                    self.log.error('Error adding ' + wfName, aerr);
                } else {
                    self.log.debug(wfName + ' workflow added');
                    self.uuids[wf] = uuid;
                }
            });
        }
    });
};



/*
 * Retrieves a workflow by name.
 */
WfClient.prototype.findWorkflow = function (name, cb) {
    this.client.get('/workflows', function (err, req, res, wfs) {
        if (err)
            return cb(err);

        if (!wfs.length)
            return cb(null, null);

        for (var i = 0; i < wfs.length; i++) {
            var wf = wfs[i];

            if (wf.name.indexOf(name) != -1)
                return cb(null, wf);
        }

        return cb(null, null);
    });
};



/*
 * Retrieves a workflow by uuid.
 */
WfClient.prototype.getWorkflow = function (uuid, cb) {
    this.client.get('/workflows/' + uuid, function (err, req, res, wf) {
        if (err)
            return cb(err);

        return cb(null, wf);
    });
};



/*
 * Creates a workflow on WFAPI.
 */
WfClient.prototype.createWorkflow = function (name, cb) {
    var self = this;
    var file = require(this.path + name);

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
WfClient.prototype.serializeWorkflow = function (wf) {
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
 * Queues a new job.
 */
WfClient.prototype.createJob = function (wf, params, cb) {
    if (!wf)
        throw new TypeError('workflow name \'wf\' is required (string)');
    if (!params || typeof (params) !== 'object')
        throw new TypeError('params is required (object)');
    if (!params.target)
        throw new TypeError('job target is required (string)');

    var self = this;
    params.workflow = self.uuids[wf];

    this.client.post('/jobs', params, function (err, req, res, job) {
        if (err)
            return cb(err);

        assert.ok(job.uuid);
        assert.equal(job.execution, 'queued');
        return cb(null, job);
    });
};



/*
 * Retrieves a job by uuid.
 */
WfClient.prototype.getJob = function (uuid, cb) {
    this.client.get('/jobs/' + uuid, function (err, req, res, job) {
        if (err)
            return cb(err);

        return cb(null, job);
    });
};



/*
 * Lists jobs.
 */
WfClient.prototype.listJobs = function (params, cb) {
    var getParams = { path: '/jobs' };
    getParams.query = params;

    this.client.get(getParams, function (err, req, res, jobs) {
        if (err)
            return cb(err);

        return cb(null, jobs);
    });
};



module.exports = WfClient;
