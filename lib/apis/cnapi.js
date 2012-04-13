/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var restify = require('restify');


/*
 * CNAPI Constructor
 */
function Cnapi(options) {
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



/*
 * Retrieves machine information from CNAPI
 */
Cnapi.prototype.getMachine = function (serverUuid, uuid, callback) {
    var path = '/servers/' + serverUuid + '/vms/' + uuid;

    this.client.get(path, function (err, req, res, machine) {
        if (err)
          return callback(err, null);

        return callback(null, machine);
    });
}


module.exports = Cnapi;
