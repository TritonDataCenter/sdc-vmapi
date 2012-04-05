/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var restify = require('restify');
var provision = require('../workflows/provision');


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
      self.provisionWf = uuid;
    } else {

      self.log.debug('Provision workflow doesn\'t exist, let\'s create it');
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



Wfapi.prototype.serializeWorkflow = function (workflow) {

  if (workflow.chain.length) {
    for (var i = 0; i < workflow.chain.length; i++) {

      if (workflow.chain[i].body)
        workflow.chain[i].body = workflow.chain[i].body.toString();

      if (workflow.chain[i].fallback)
        workflow.chain[i].fallback = workflow.chain[i].fallback.toString();
    }
  }


  if (workflow.onerror.length) {
    for (var i = 0; i < workflow.onerror.length; i++) {

      if (workflow.onerror[i].body)
        workflow.onerror[i].body = workflow.onerror[i].body.toString();
    }
  }

  return workflow;
}



module.exports = Wfapi;
