/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


// This is not really needed, but javascriptlint will complain otherwise:
var sdcClients = require('sdc-clients');
var uuid = require('node-uuid');


function validateForZoneAction(job, cb) {
    if (!job.params.cnapiUrl)
        return cb('No CNAPI URL provided');

    if (!job.params.muuid)
        return cb('Machine UUID is required');

    return cb(null, 'All parameters OK!');
}


function zoneAction(job, cb) {
    if (!job.endpoint)
        return cb('No CNAPI endpoint provided');

    if (!job.requestMethod)
        return cb('No HTTP request method provided');

    var cnapi = restify.createJsonClient({ url: job.params.cnapiUrl });

    function callback(err, req, res, task) {
        if (err) {
            return cb(err.name + ': ' + err.body.message);
        } else {
            job.params.taskId = task.id;
            return cb(null, 'Task queued to CNAPI!');
        }
    }

    var action;

    if (job.requestMethod == 'post')
        return cnapi.post(job.endpoint, job.params, callback);
    else if (job.requestMethod == 'del')
        return cnapi.del(job.endpoint, callback);
    else
        return cb('Unsupported requestMethod: "' + job.requestMethod + '"');
}



module.exports = {
    validateForZoneAction: validateForZoneAction,
    zoneAction: zoneAction
};
