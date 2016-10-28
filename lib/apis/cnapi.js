/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * A brief overview of this source file: what is its purpose.
 */


var restifyClients = require('restify-clients');
var tritonTracer = require('triton-tracer');

// Wrap the clients with tracing magic.
restifyClients = tritonTracer.wrapRestifyClients({
    restifyClients: restifyClients
});


/*
 * CNAPI Constructor
 */
function Cnapi(options) {
    this.log = options.log;

    this.client = restifyClients.createJsonClient({
        url: options.url,
        version: '*',
        log: options.log,
        agent: options.agent
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
 * Retrieves vm /proc information from CNAPI (experimental)
 */
Cnapi.prototype.getVmProc = function (serverUuid, uuid, callback) {
    var self = this;
    var path = '/servers/' + serverUuid + '/vms/' + uuid + '/proc';

    function onGetVmProc(err, req, res, proc) {
        var body = (res && res.body) || '';
        self.log.trace('machine_proc response. error: %s body: %s', err, body);

        if (err) {
            return callback(err);
        } else if (proc) {
            return callback(null, proc);
        } else {
            self.log.error({ server: serverUuid },
                'Unexpected response from CNAPI', res);
            return callback(new Error('Unexpected response from CNAPI'));
        }
    }

    return self.client.get(path, onGetVmProc);
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
            var notfound = (
                (res && res.statusCode && res.statusCode === 404) ||
                (vm && vm.message &&
                    (vm.message.indexOf('VM.load error') !== -1)) ||
                (vm && vm.message &&
                    (vm.message.indexOf('vmadm.load error') !== -1)));

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


/*
 * Wait for a task to complete or a timeout to be fired.
 */
Cnapi.prototype.waitTask = function (id, options, callback) {
    if (!id) {
        callback(new Error('task id is required'));
        return;
    }

    if (typeof (options) === 'function') {
        callback = options;
        options = undefined;
    }

    var path = '/tasks/' + encodeURIComponent(id) + '/wait';

    if (options.timeout) {
        path += '?timeout=' + options.timeout;
    }

    var opts = { path: path };

    if (options && options.headers) {
        opts.headers = options.headers;
    }

    this.client.get(opts, callback);
};


module.exports = Cnapi;
