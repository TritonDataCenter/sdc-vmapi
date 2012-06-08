/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var restify = require('restify');
var common = require('./../common');


/*
 * NAPI Constructor
 */
function Napi(options) {
    this.log = options.log;

    this.client = restify.createJsonClient({
        url: options.url,
        version: '*',
        retryOptions: {
            retry: 0
        },
        log: options.log
    });

    this.client.basicAuth(options.username, options.password);
}



/*
 * Retrieves NIC information from NAPI
 */
Napi.prototype.getNics = function (params, callback) {
    var getParams = {
        path: '/nics',
        query: params
    };

    return this.client.get(getParams, function (err, req, res, nics) {
        if (err)
          return callback(err, null);

        return callback(null, nics);
    });
};



/*
 * Retrieves NIC information from NAPI
 */
Napi.prototype.getNic = function (mac, callback) {
    var theMac = mac.replace(/:/g, '');

    return this.client.get('/nics/' + theMac, function (err, req, res, nic) {
        if (res.statusCode == 404)
          return callback(null, null);

        if (err)
          return callback(err, null);

        return callback(null, nic);
    });
};



/*
 * Adds a new NIC on NAPI
 */
Napi.prototype.addNic = function (params, callback) {
    return this.client.post('/nics', params, function (err, req, res, nic) {
        if (err)
          return callback(err, null);

        return callback(null, nic);
    });
};



/*
 * Adds NICs to NAPI only when they don't exist yet
 */
Napi.prototype.addNics = function (vm) {
    var self = this;
    var i;

    if (!vm.nics.length) {
        self.log.info('VM ' + vm.uuid + ' didn\'t have any NICs to add');
        return true;
    }

    var postParams = {
        owner_uuid: vm.owner_uuid,
        belongs_to_uuid: vm.uuid,
        belongs_to_type: 'zone'
    };

    function getAddNic(nic) {
        self.getNic(nic.mac, function (nerr, aNic) {
            if (nerr)
                self.log.error(nerr);

            if (!aNic) {
                var allParams = common.simpleMerge(nic, postParams);
                self.addNic(allParams, function(aerr) {
                    if (aerr)
                        self.log.error(aerr);

                    self.log.info('NIC ' + nic.mac + ' added to NAPI');
                });
            } else {
                self.log.info('NIC ' + nic.mac + ' already on NAPI');
            }
        });
    }

    for (i = 0; i < vm.nics.length; i++) {
        getAddNic(vm.nics[i]);
    }
}



/*
 * Adds a new NIC on NAPI
 */
Napi.prototype.deleteNic = function (mac, callback) {
    return this.client.del('/nics/' + mac.replace(/:/g, ''), 
        function (err, req, res, nic) {
        if (err)
          return callback(err, null);

        return callback(null, nic);
    });
};



/*
 * Deletes NICs from NAPI only when a VM is deleted
 */
Napi.prototype.deleteNics = function (vm) {
    var self = this;

    if (!vm.nics.length) {
        self.log.info('VM ' + vm.uuid + ' didn\'t have any NICs to destroy')
        return true;
    }

    for (var i = 0; i < vm.nics.length; i++) {
        var nic = vm.nics[i];

        self.deleteNic(nic.mac, function(err) {
            if (err)
                self.log.error(err);

            self.log.info('NIC ' + nic.mac + ' deleted from NAPI');
        });
    }
};


module.exports = Napi;
