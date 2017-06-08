/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * Functions for dealing with NAPI (the SDC Network API)
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
        log: options.log,
        agent: options.agent
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
 * Updates a NIC on NAPI
 */
Napi.prototype.updateNic = function (mac, params, callback) {
    var path = '/nics/' + mac.replace(/:/g, '');
    return this.client.put(path, params, function (err, req, res, nic) {
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

    var antiSpoofFields = ['allow_dhcp_spoofing', 'allow_ip_spoofing',
        'allow_mac_spoofing', 'allow_restricted_traffic',
        'allow_unfiltered_promisc'];

    var postParams = {
        owner_uuid: vm.owner_uuid,
        belongs_to_uuid: vm.uuid,
        belongs_to_type: 'zone'
    };

    for (var p in extra) {
        postParams[p] = extra[p];
    }

    function nicChanged(cur, old) {
        var fields = [ 'vlan_id', 'nic_tag', 'primary', 'ip',
            'netmask', 'state' ].concat(antiSpoofFields);
        var field;
        var diff = false;

        for (var i = 0; i < fields.length; i++) {
            field = fields[i];
            if (cur[field] !== old[field]) {
                diff = true;
                break;
            }
        }

        return diff;
    }

    function sanitizeBooleanAntiSpoof(params) {
        function booleanFromValue(value) {
            if (value === 'false' || value === '0') {
                return false;
            } else if (value === 'true' || value === '1') {
                return true;
            } else {
                // else should be boolean
                return value;
            }
        }

        antiSpoofFields.forEach(function (field) {
            if (params[field] !== undefined) {
                params[field] = booleanFromValue(params[field]);
            }
        });
    }

    async.mapSeries(vm.nics, function (nic, next) {
        self.getNic(nic.mac, function (err, oldNic) {
            if (err) {
                self.log.error('Error getting NIC %s', nic.mac);
                return next(err);
            } else {
                // ZAPI-525: we need to manually add nic.state because this
                // property doesn't live in the 'nics' attribute in the VM
                nic.state = (vm.state === 'running' ? 'running' : 'stopped');

                var allParams = common.simpleMerge(nic, postParams);
                if (allParams.vlan_id === undefined) {
                    allParams.vlan_id = 0;
                }
                allParams.vlan = allParams.vlan_id;

                sanitizeBooleanAntiSpoof(allParams);

                if (!oldNic) {
                    self.addNic(allParams, function (addErr) {
                        if (addErr) {
                            self.log.error('Could not add NIC %s for VM %s',
                                nic.mac, vm.uuid);
                        } else {
                            self.log.info('NIC %s added for VM %s',
                                nic.mac,  vm.uuid);
                        }
                        return next(addErr);
                    });
                } else {
                    // Only update NICs when they haven't changed
                    if (!nicChanged(nic, oldNic)) {
                        self.log.info('NIC %s for VM %s unchanged on NAPI',
                            nic.mac, vm.uuid);
                        return next();
                    }

                    // For boolean nic fields, if the value is set in NAPI
                    // but not in the update, unset it in NAPI.
                    for (var i = 0; i < antiSpoofFields.length; i++) {
                        var field = antiSpoofFields[i];
                        if (oldNic.hasOwnProperty(field) &&
                                !nic.hasOwnProperty(field)) {
                            allParams[field] = false;
                        }
                    }

                    self.updateNic(nic.mac, allParams, function (addErr) {
                        if (addErr) {
                            self.log.error('Could not update NIC %s for VM %s',
                                nic.mac, vm.uuid);
                        } else {
                            self.log.info('NIC %s updated for VM %s',
                                nic.mac,  vm.uuid);
                        }
                        return next(addErr);
                    });
                }
            }
        });

    }, function (err) {
        return callback(err);
    });
};



/*
 * Changes the states of NICs based on the VM's state.
 */
Napi.prototype.updateNicsState = function (vmUuid, vmState, callback) {
    var self = this;

    var nicState = (vmState === 'running' ? 'running' : 'stopped');

    self.getNics({
        belongs_to_uuid: vmUuid,
        belongs_to_type: 'zone'
    }, function (err, nics) {
        if (err) {
            return callback(err);
        }

        return async.mapSeries(nics, function (nic, next) {
            if (nic.state === nicState) {
                next();
            }

            self.updateNic(nic.mac, { state: nicState }, function (err2) {
                if (err2) {
                    self.log.error(err2, 'Could not update NIC %s for VM %s',
                        nic.mac, vmUuid);
                } else {
                    self.log.info('NIC %s updated for VM %s', nic.mac,  vmUuid);
                }

                return next(err2);
            });
        }, callback);
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
        self.log.info('VM %s didn\'t have any NICs to destroy', vm.uuid);
        if (callback !== undefined) {
            callback();
        }
        return;
    }

    async.mapSeries(vm.nics, function (nic, next) {
        self.deleteNic(nic.mac, function (err) {
            if (err) {
                self.log.error('Could not delete NIC %s for VM %s', nic.mac,
                    vm.uuid);
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
