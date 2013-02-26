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
        log: options.log
    });

    this.client.basicAuth(options.username, options.password);
}



/*
 * Pings NAPI by calling /networks
 */
Napi.prototype.ping = function (callback) {
    this.client.get('/networks', function (err, req, res) {
        return callback(err);
    });
};



/*
 * Retrieves NIC information from NAPI
 */
Napi.prototype.getNics = function (params, callback) {
    var getParams = {
        path: '/nics',
        query: params
    };

    return this.client.get(getParams, function (err, req, res, nics) {
        if (err) {
          return callback(err, null);
        }

        return callback(null, nics);
    });
};



/*
 * Retrieves NIC information from NAPI
 */
Napi.prototype.getNic = function (mac, callback) {
    var theMac = mac.replace(/:/g, '');

    return this.client.get('/nics/' + theMac, function (err, req, res, nic) {
        // 404 is also an error object
        if (err) {
            if (res && (res.statusCode == 404)) {
                return callback(null, null);
            } else {
                return callback(err, null);
            }
        }

        return callback(null, nic);
    });
};



/*
 * Adds a new NIC on NAPI
 */
Napi.prototype.addNic = function (params, callback) {
    return this.client.post('/nics', params, function (err, req, res, nic) {
        if (err) {
          return callback(err, null);
        }

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
        return;
    }

    var postParams = {
        owner_uuid: vm.owner_uuid,
        belongs_to_uuid: vm.uuid,
        belongs_to_type: 'zone'
    };

    function onGetNic(err, oldNic, nic) {
        if (err) {
            self.log.error(err);

        } else {
            if (!oldNic) {
                var allParams = common.simpleMerge(nic, postParams);
                if (allParams['vlan_id'] === undefined) {
                    allParams['vlan_id'] = 0;
                }
                allParams['vlan'] = allParams['vlan_id'];

                self.addNic(allParams, function (addErr) {
                    onAddNic(addErr, nic);
                });

            } else {
                self.log.info('NIC ' + nic.mac + ' for VM ' +
                    vm.uuid + ' already on NAPI');
            }
        }
    }

    function onAddNic(err, nic) {
        if (err) {
            self.log.info('Could not add NIC ' + nic.mac +
                ' for VM ' + vm.uuid);
            self.log.error(err);
        } else {
            self.log.info('NIC ' + nic.mac + ' added for VM ' + vm.uuid);
        }
    }

    function getAddNic(nic) {
        self.getNic(nic.mac, function (err, oldNic) {
            onGetNic(err, oldNic, nic);
        });
    }

    for (i = 0; i < vm.nics.length; i++) {
        getAddNic(vm.nics[i]);
    }
};



/*
 * Adds a new NIC on NAPI
 */
Napi.prototype.deleteNic = function (mac, callback) {
    this.client.del('/nics/' + mac.replace(/:/g, ''),
        function (err, req, res, nic) {
        if (err) {
            callback(err, null);
            return;
        }

        callback(null, nic);
    });
};



/*
 * Deletes NICs from NAPI only when a VM is deleted
 */
Napi.prototype.deleteNics = function (vm) {
    var self = this;

    if (!vm.nics.length) {
        self.log.info('VM ' + vm.uuid + ' didn\'t have any NICs to destroy');
        return;
    }

    function onDeleteNic(err, a_nic) {
        if (err) {
            self.log.info('Could not delete NIC ' + a_nic.mac +
                ' for VM ' + vm.uuid);
            self.log.error(err);
        } else {
            self.log.info('NIC ' + a_nic.mac + ' for VM ' + vm.uuid +
                ' deleted from NAPI');
        }
    }

    for (var i = 0; i < vm.nics.length; i++) {
        var nic = vm.nics[i];

        self.deleteNic(nic.mac, function (err) {
            onDeleteNic(err, nic);
        });
    }
};


module.exports = Napi;
