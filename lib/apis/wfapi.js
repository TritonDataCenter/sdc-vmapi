/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var restify = require('restify');
var provision = require('../workflows/provision');
var assert = require('assert');
var uuid = require('node-uuid');


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

    this.provisionWf = null;
}



Wfapi.prototype.initWorkflows = function () {
    var self = this;

    self.getWorkflow('provision', function (err, uuid) {
        if (err)
            self.log.error('Could not find provision workflow', err);

        if (uuid) {
            self.log.debug('Provision workflow exists');
            self.provisionWf = uuid;
        } else {

            self.log.debug('Provision workflow doesn\'t exist, ' +
                           'let\'s create it');
            self.createWorkflow('provision', function (err, uuid) {
                if (err)
                    self.log.error('Could not find provision workflow', err);
                else
                    self.provisionWf = uuid;
            });
        }
    });
}



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



Wfapi.prototype.createWorkflow = function (name, cb) {
    var self = this;
    var serialized = self.serializeWorkflow(provision);

    self.client.post('/workflows', serialized, function (err, req, res, wf) {
        if (err)
            return cb(err);

        return cb(null, wf.uuid);
    });
}



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



Wfapi.prototype.createProvision = function (req, cb) {
    var muuid = uuid();
    var job = req.params;

    job.target = '/provision-' + muuid;
    job.muuid = muuid;
    job.zonename = muuid;
    job.workflow = this.provisionWf;

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



Wfapi.prototype.getJob = function (uuid, cb) {
    this.client.get('/jobs/' + uuid, function (err, req, res, job) {
        if (err)
            return cb(err);

        return cb(null, job);
    });
}


module.exports = Wfapi;
