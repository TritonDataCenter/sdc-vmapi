/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var restify = require('restify');


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
}


Wfapi.prototype.initWorkflows = function () {
  return true;
}

module.exports = Wfapi;
