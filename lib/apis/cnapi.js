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
        log: options.log,
        retry: { retries: 2 }
    });
}



/*
 * Pings CNAPI
 */
Cnapi.prototype.ping = function (callback) {
    this.client.get('/ping', function (err, req, res) {
        return callback(err);
    });
};



/*
 * Gets a Server record from CNAPI
 */
Cnapi.prototype.getServer = function (uuid, callback) {
    var path = '/servers/' +  encodeURIComponent(uuid);
    this.client.get(path, function (err, req, res, server) {
        return callback(err, server);
    });
};



/*
 * Get Image
 */
Cnapi.prototype.getImage = function (uuid, image_uuid, callback) {
    var path = '/servers/' + encodeURIComponent(uuid) + '/images/' +
        encodeURIComponent(image_uuid);
    this.client.get(path, function (err, req, res, image) {
        return callback(err, image);
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
                self.log.error({ err: err, server: serverUuid },
                    'Unexpected response, VM does not exist', res.body);
                return callback(null, null);
            } else {
                return callback(err, null);
            }
        } else if (vm) {
            return callback(null, vm);
        } else {
            self.log.error({ server: serverUuid },
                'Unexpected response from CNAPI', res);
            return callback(new Error('Unexpected response from CNAPI'));
        }
    }

    return self.client.get(path, onGetVm);
};


/*
 * Gets the capacity object from a server
 */
Cnapi.prototype.capacity = function (server, callback) {
    var params = { servers: [ server ] };
    this.client.post('/capacity', params, function (err, req, res, obj) {
        return callback(err, obj);
    });
};


module.exports = Cnapi;
