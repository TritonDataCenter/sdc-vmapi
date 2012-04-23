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

    this.workflows = options.workflows;
    this.uuids = {};
}



/*
 * Intializes all workflows that ZAPI needs to be aware of.
 */
Wfapi.prototype.initWorkflows = function () {
    var self = this;

    self.workflows.forEach(function (wf) {
        self.getWorkflow(wf, function (err, uuid) {
            if (err)
                self.log.error('Error getting workflow "' + wf + '"', err);

            if (uuid) {
                self.log.debug('Workflow "' + wf + '" exists');
                self.uuids[wf] = uuid;
            } else {
                self.log.debug('"' + wf + '" workflow doesn\'t exist, ' +
                               'let\'s create it');
                self.createWorkflow(wf, function (err, uuid) {
                    if (err)
                        self.log.error('Could not find "' + wf +
                                       '" workflow', err);
                    else
                        self.uuids[wf] = uuid;
                });
            }
        });
    });
}



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
}



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
}



/*
 * Serializes a workflow object. This function is basically converting object
 * properties that are functions into strings, so they can be properly
 * represented as JSON
 */
Wfapi.prototype.serializeWorkflow = function (wf) {
    if (wf.chain.length) {
        for (var i = 0; i < wf.chain.length; i++) {
            if (wf.chain[i].body)
                wf.chain[i].body = wf.chain[i].body.toString();

            if (wf.chain[i].fallback)
                wf.chain[i].fallback = wf.chain[i].fallback.toString();
        }
    }


    if (wf.onerror.length) {
        for (var i = 0; i < wf.onerror.length; i++) {
            if (wf.onerror[i].body)
                wf.onerror[i].body = wf.onerror[i].body.toString();
      }
    }

    return wf;
}



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
    job.dapiUsername = req.config.dapi.username;
    job.dapiPassword = req.config.dapi.password;

    job.cnapiUrl = req.config.cnapi.url;

    this.client.post('/jobs', job, function (err, req, res, job) {
        if (err)
            return cb(err);

        assert.ok(job.uuid);
        assert.equal(job.execution, 'queued');
        return cb(null, muuid, job.uuid);
    });
}



/*
 * Queues a start job.
 */
Wfapi.prototype.createStartJob = function (req, cb) {
    var muuid = req.machine.uuid;
    var job = req.params;

    job.target = '/start-' + muuid;
    job.muuid = muuid;
    job.zonename = muuid;
    job.workflow = this.uuids['start'];
    job.server_uuid = req.machine.serveruuid;

    // APIs
    job.cnapiUrl = req.config.cnapi.url;

    this.client.post('/jobs', job, function (err, req, res, job) {
        if (err)
            return cb(err);

        assert.ok(job.uuid);
        assert.equal(job.execution, 'queued');
        return cb(null, job.uuid);
    });
}



/*
 * Queues a stop job.
 */
Wfapi.prototype.createStopJob = function (req, cb) {
    var muuid = req.machine.uuid;
    var job = req.params;

    job.target = '/stop-' + muuid;
    job.muuid = muuid;
    job.zonename = muuid;
    job.workflow = this.uuids['stop'];
    job.server_uuid = req.machine.serveruuid;

    // APIs
    job.cnapiUrl = req.config.cnapi.url;

    this.client.post('/jobs', job, function (err, req, res, job) {
        if (err)
            return cb(err);

        assert.ok(job.uuid);
        assert.equal(job.execution, 'queued');
        return cb(null, job.uuid);
    });
}



/*
 * Queues a reboot job.
 */
Wfapi.prototype.createRebootJob = function (req, cb) {
    var muuid = req.machine.uuid;
    var job = req.params;

    job.target = '/reboot-' + muuid;
    job.muuid = muuid;
    job.zonename = muuid;
    job.workflow = this.uuids['reboot'];
    job.server_uuid = req.machine.serveruuid;

    // APIs
    job.cnapiUrl = req.config.cnapi.url;

    this.client.post('/jobs', job, function (err, req, res, job) {
        if (err)
            return cb(err);

        assert.ok(job.uuid);
        assert.equal(job.execution, 'queued');
        return cb(null, job.uuid);
    });
}



/*
 * Retrieves a job from WFAPI.
 */
Wfapi.prototype.getJob = function (uuid, cb) {
    this.client.get('/jobs/' + uuid, function (err, req, res, job) {
        if (err)
            return cb(err);

        return cb(null, job);
    });
}



module.exports = Wfapi;
