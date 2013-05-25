/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var restify = require('restify');
var common = require('./../common');
var async = require('async');


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
}



/*
 * Pings NAPI
 */
Napi.prototype.ping = function (callback) {
    this.client.get('/ping', function (err, req, res) {
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
            if (res && (res.statusCode === 404)) {
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
Napi.prototype.addNics = function (vm, extra, callback) {
    var self = this;

    if (!vm.nics.length) {
        self.log.info('VM %s didn\'t have any NICs to add', vm.uuid);
        return callback();
    }

    var postParams = {
        owner_uuid: vm.owner_uuid,
        belongs_to_uuid: vm.uuid,
        belongs_to_type: 'zone'
    };

    for (var p in extra) {
        postParams[p] = extra[p];
    }

    async.mapSeries(vm.nics, function (nic, next) {
        self.getNic(nic.mac, function (err, oldNic) {
            if (err) {
                self.log.error(err, 'Error getting NIC %s', nic.mac);
                return next(err);
            } else {
                if (!oldNic) {
                    var allParams = common.simpleMerge(nic, postParams);
                    if (allParams['vlan_id'] === undefined) {
                        allParams['vlan_id'] = 0;
                    }
                    allParams['vlan'] = allParams['vlan_id'];

                    self.addNic(allParams, function (addErr) {
                        if (addErr) {
                            self.log.error(addErr,
                                'Could not add NIC %s for VM %s',
                                nic.mac, vm.uuid);
                        } else {
                            self.log.info('NIC %s added for VM %s',
                                nic.mac,  vm.uuid);
                        }
                        return next(addErr);
                    });
                } else {
                    self.log.info('NIC %s for VM %s already on NAPI',
                        nic.mac, vm.uuid);
                    return next();
                }
            }
        });

    }, function (err) {
        return callback(err);
    });
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
Napi.prototype.deleteNics = function (vm, callback) {
    var self = this;

    if (!vm.nics || !vm.nics.length) {
        self.log.info('VM % didn\'t have any NICs to destroy', vm.uuid);
        return;
    }

    async.mapSeries(vm.nics, function (nic, next) {
        self.deleteNic(nic.mac, function (err) {
            if (err) {
                self.log.error(err, 'Could not delete NIC %s for VM %s',
                    nic.mac, vm.uuid);
            } else {
                self.log.info('NIC %s for VM %s deleted from NAPI',
                    nic.mac, vm.uuid);
            }
            return next(err);
        });
    }, function (err) {
        return callback(err);
    });
};


module.exports = Napi;
