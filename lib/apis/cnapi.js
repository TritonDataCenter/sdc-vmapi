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
        log: options.log
    });
}



/*
 * Retrieves vm information from CNAPI
 */
Cnapi.prototype.getVm = function (serverUuid, uuid, callback) {
    var self = this;
    var path = '/servers/' + serverUuid + '/vms/' + uuid;

    function onGetVm(err, req, res, vm) {
        // TRACE with UFDS is too noisy
        var body = (res && res.body) || '';
        self.log.debug('machine_load response. error: %s body: %s', err, body);

        if (err) {
            if (res && (res.statusCode == 404)) {
                return callback(null, null);
            } else {
                return callback(err, null);
            }
        }

        return callback(null, vm);
    }

    return self.client.get(path, onGetVm);
};



module.exports = Cnapi;
