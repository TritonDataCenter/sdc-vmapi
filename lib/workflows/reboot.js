/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


// This is not really needed, but javascriptlint will complain otherwise:
var sdcClients = require('sdc-clients');
var uuid = require('node-uuid');

function validateParams(job, cb) {
    if (!job.params.cnapiUrl)
        return cb('No CNAPI URL provided');

    if (!job.params.muuid)
        return cb('Machine UUID is required');

    return cb(null, 'All parameters OK!');
}



function reboot(job, cb) {
    var cnapi = restify.createJsonClient({ url: job.params.cnapiUrl });
    var endpoint = '/servers/' +
                   job.params.server_uuid + '/vms/' +
                   job.params.muuid + '/reboot';
    job.params.jobid = job.uuid;

    return cnapi.post(endpoint, job.params, function (err, req, res, task) {

      if (err) {
          return cb(err.name + ': ' + err.body.message);
      } else {
          job.params.taskId = task.id;
          return cb(null, 'Reboot queued!');
      }
    });
}



var workflow = module.exports = {
    name: 'reboot-' + uuid(),
    chain: [ {
        name: 'Validate parameters',
        timeout: 30,
        retry: 1,
        body: validateParams
    }, {
        name: 'Reboot',
        timeout: 120,
        retry: 1,
        body: reboot
    }],
    timeout: 180,
    onerror: [ {
        name: 'On error',
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }]
};