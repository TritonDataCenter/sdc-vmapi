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



function stop(job, cb) {
    var cnapi = restify.createJsonClient({ url: job.params.cnapiUrl });
    var endpoint = '/servers/' +
                   job.params.server_uuid + '/vms/' +
                   job.params.muuid + '/stop';

    function pollTask(task_id) {
        // We have to poll the task until it completes. Ensure the timeout is
        // big enough so the provision ends on time
        var intervalId = setInterval(function () {
            cnapi.get('/tasks/' + task_id, function (err, req, res, task) {
                if (err) {
                    return cb(new Error(err.name + ': ' + err.body.message));
                } else {

                    job.params.task = {
                        id: task.id,
                        progress: task.progress,
                        status: task.status
                    };

                    if (task.status == 'failure') {
                        clearInterval(intervalId);
                        cb('Stop failed');
                        return;

                    } else if (task.status == 'complete') {
                        clearInterval(intervalId);
                        cb(null, 'Stop succeeded!');
                        return;
                    }
                }
            });
        }, 3000);
    }

    return cnapi.post(endpoint, job.params, function (err, req, res, task) {

      if (err) {
          return cb(err.name + ': ' + err.body.message);

      } else {
          job.params.task = { id: task.id };
          pollTask(task.id);
      }
    });
}



var workflow = module.exports = {
    name: 'stop-' + uuid(),
    chain: [ {
        name: 'Validate parameters',
        timeout: 30,
        retry: 1,
        body: validateParams
    }, {
        name: 'Stop',
        timeout: 120,
        retry: 1,
        body: stop
    }],
    timeout: 180,
    onerror: [ {
        name: 'On error',
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }]
};