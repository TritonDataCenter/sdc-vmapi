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
 * Pings CNAPI by calling /loglevel
 */
Cnapi.prototype.ping = function (callback) {
    this.client.get('/loglevel', function (err, req, res) {
        return callback(err);
    });
};



/*
 * Retrieves vm information from CNAPI
 */
Cnapi.prototype.getVm = function (serverUuid, uuid, acceptNotFound, callback) {
    var self = this;
    var path = '/servers/' + serverUuid + '/vms/' + uuid;

    function onGetVm(err, req, res, vm) {
        var body = (res && res.body) || '';
        self.log.trace('machine_load response. error: %s body: %s', err, body);

        if (err) {
            // getVm with sync=true will check if the error just means that the
            // VM is not there and we need to mark it as destroyed
            /*JSSTYLED*/
            var notfound = ((res && res.statusCode && res.statusCode == 404) || (vm && vm.message && (vm.message.indexOf('VM.load error') != -1)));

            if (notfound && acceptNotFound) {
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
