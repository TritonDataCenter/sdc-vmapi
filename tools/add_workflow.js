/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

// Call from parent directory with:
//   `node api.js $login $password`


var params = {
  "ufdsUrl": "ldaps://10.88.88.50:636",
  "ufdsDn": "cn=root",
  "ufdsPassword": "secret"
};


var restify = require('restify'),
    util = require('util'),
    assert = require('assert');

var client = restify.createJsonClient({
  url: 'http://10.99.99.22:8080'
});

var aWorkflow = require('../lib/workflows/get_packages');
assert.ok(aWorkflow);

// API needs everything being JSON, while node-module takes care of
// this by itself so, stringify things here:
aWorkflow.chain[0].body = aWorkflow.chain[0].body.toString();
aWorkflow.chain[1].body = aWorkflow.chain[1].body.toString();
aWorkflow.onerror[0].body = aWorkflow.onerror[0].body.toString();

client.post('/workflows', aWorkflow, function (err, req, res, wf) {
  assert.ifError(err);
  assert.ok(wf.uuid);
  console.log("Workflow created!");

  var aJob = {
    target: '/packages-' + wf.uuid,
    workflow: wf.uuid,
    ufdsUrl: "ldaps://10.88.88.50:636",
    ufdsDn: "cn=root",
    ufdsPassword: "secret"
  };

  client.post('/jobs', aJob, function (err, req, res, job) {
    assert.ifError(err);
    assert.ok(job);
    assert.equal(job.execution, 'queued');
    assert.ok(job.uuid);

    var intervalId = setInterval(function () {
      client.get('/jobs/' + job.uuid, function (err, req, res, obj) {
        assert.ifError(err);
        if (obj.execution === 'queued') {
          console.log('Job waiting to be processed');
        } else if (obj.execution === 'running') {
          console.log('Job in progress ...');
        } else {
          console.log('Job finished. Here come the results:');
          console.log(util.inspect(obj, false, 8));
          // Only one workflow with the same name, need to delete it to allow
          // creating it again:
          client.del('/workflows/' + wf.uuid, function (err, req, res, obj) {
            assert.ifError(err);
            clearInterval(intervalId);
            process.exit(0);
          });
        }
      });
    }, 3000);

  });

});