/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var util = require('util');
var amqp = require('amqp');
var common = require('./common');
var assert = require('assert-plus');
var EventEmitter = require('events').EventEmitter;
var async = require('async');


/*
 * Heartbeater constructor. options is an object with the following properties:
 *  - host: AMQP host
 *  - queue: AMQP queue. Defaults to 'heartbeat.vmapi'
 *  - log: bunyan logger instance
 */
function Heartbeater(options) {
    assert.object(options, 'amqp options');
    assert.string(options.host, 'amqp options.host');

    this.host = options.host;
    this.queue = options.queue || 'heartbeat.vmapi';
    this.log = options.log;

    EventEmitter.call(this);

    this.connection = amqp.createConnection({ host: this.host });
    this.reconnectTimeout = (options.reconnect || 5) * 1000;

    this.connection.on('error', this.onError.bind(this));
    this.connection.on('ready', this.onReady.bind(this));
}

util.inherits(Heartbeater, EventEmitter);



/*
 * Reconnects to the AMQP host
 */
Heartbeater.prototype.reconnect = function () {
    this.connection.reconnect();
};



/*
 * On error gets called when a AMQP connection error is produced
 */
Heartbeater.prototype.onError = function (err) {
    var self = this;

    this.log.error('AMQP Connection Error ' + err.code +
                   ', re-trying in 5 seconds...');

    setTimeout(function () {
        self.reconnect();
    }, this.reconnectTimeout);
};



/*
 * On ready gets called when the connection to the AMQP was successfully
 * established. From here we can start using AMQP
 */
Heartbeater.prototype.onReady = function () {
    var self = this;
    var connection = self.connection;

    self.log.debug('Connected to AMQP');
    var queue = connection.queue(self.queue);

    function onQueueOpen() {
        self.log.debug('Binded queue to exchange');
        queue.bind('heartbeat.*');
        queue.subscribeJSON(onJson);
    }

    function onJson(message, headers, deliveryInfo) {
        assert.object(message, 'amqp message');
        assert.string(deliveryInfo.routingKey, 'amqp routingKey');

        var serverUuid = deliveryInfo.routingKey.split('.')[1];
        self.emit('heartbeat', serverUuid, message.zoneStatus);
    }

    queue.on('open', onQueueOpen);
};



/*
 * Array to hash
 */
function arrayToHash(array) {
    var hash = {};

    for (var i = 0; i < array.length; i++) {
        hash[array[i]] = 1;
    }

    return hash;
}



/*
 * Compares the new set of UUIDs with the previously cached. If there are
 * missing UUIDs we can assume the vm was destroyed and proceed to mark as
 * destroyed on UFDS. This function reads server-vms hash on redis, which holds
 * the last available list of active vms on a server.
 */
Heartbeater.prototype.getMissingUuids = function (cache, server, hbs, cb) {
    var self = this;
    var uuids = [];
    var missing = [];

    // Maps to an array of UUIDs currently active in the server
    hbs.forEach(function (hb) {
        var uuid = hb[1];
        if (uuid != 'global') {
            uuids.push(uuid);
        }
    });

    function onCache(err, cached) {
        if (err) {
            self.log.error('Could not get list of cached VM UUIDs for ' +
                'server %s', server);
            cb(err);
            return;
        }

        cached.forEach(function (uuid) {
            if (uuids.indexOf(uuid) == -1) {
                missing.push(uuid);
            }
        });

        var newHash = arrayToHash(uuids);

        cache.setVmsForServer(server, newHash, function(err) {
            onSaveCache(err, missing);
        });
    }

    function onSaveCache(err, missing){
        if (err) {
            self.log.error('Could not cache list VM UUIDs for ' +
                'server %s', server);
            cb(err);
            return;
        }

        cb(null, missing);
    }

    cache.getVmsForServer(server, onCache);
};



/*
 * Process each heartbeat. For each heartbeat we need to check if the vm
 * exists and create it on UFDS if they don't
 *
 * Sample heartbeat:
 *    ID   zonename  status
 *   [ 0, 'global', 'running', '/', '', 'liveimg', 'shared', '0'
 */
function processHeartbeats(vmapi, server, hbs) {
    var self = this;

    if (!vmapi.cache.connected()) {
        self.log.error('Cannot process heartbeats without connection to Redis');
        return;
    }

    for (var i = 0; i < hbs.length; i++) {
        processHeartbeat(vmapi, server, hbs[i]);
    }

    self.getMissingUuids(vmapi.cache, server, hbs, function(err, missing) {
        if (err) {
            self.log.error(err);
            return;
        }

        for (i = 0; i < missing.length; i++) {
            processDestroyed(vmapi, missing[i]);
        }
    });
}

Heartbeater.prototype.processHeartbeats = processHeartbeats;



/**
 * Call machine_load from CNAPI and with that result call UFDS.
 * A call to UFDS will result in an add or replace
 */
// function cnapiThenUfds(vmapi, server, uuid) {
//     vmapi.log.debug('Calling machine_load for VM %s', uuid);

//     // Mark as 'added to ufds' by clearing up the false value in the timestamp
//     function onUfdsAdd(err, m) {
//         if (!err) {
//             var stateStamp = m['zone_state'] + ';' + m['last_modified'];
//             vmapi.cache.setState(m.uuid, stateStamp, function (cacheErr) {
//                 if (err) {
//                     vmapi.log.error('Error caching VM %s', m.uuid, err);
//                     return;
//                 }
//             });
//         }
//     }

//     function onSetVm(err, m) {
//         if (err) {
//             vmapi.log.error('Error caching VM %s', m.uuid, err);
//             return;
//         }

//         vmapi.napi.addNics(m);
//         vmapi.ufds.addUpdateVm(m, function (ufdsErr) {
//             onUfdsAdd(ufdsErr, m);
//         });
//     }

//     function onGetVm(err, vm) {
//         if (err) {
//             vmapi.log.error('Error talking to CNAPI', err);

//         } else if (vm) {
//             var m = common.translateVm(vm, false);
//             vmapi.cache.setVm(uuid, m, function(cacheErr) {
//                 onSetVm(cacheErr, m);
//             });
//         }
//     }

//     vmapi.cnapi.getVm(server, uuid, onGetVm);
// }



/**
 * Processes a single heartbeat array item
 */
// function processHeartbeat(vmapi, server, hb) {
//     var uuid = hb[1];
//     var zoneState = hb[2];
//     var lastModified = new Date(hb[8]);

//     if (uuid == 'global') {
//         return;
//     }

//     function onSetState(err) {
//         if (err) {
//             vmapi.log.error('Error caching VM state %s %s', uuid, err);
//             return;
//         }

//         vmapi.log.debug('VM state cached %s %s %s', uuid, zoneState, hb[8]);
//         cnapiThenUfds(vmapi, server, uuid);
//     }

//     function onGetState(err, state) {
//         if (err) {
//             vmapi.log.error('Error getting VM %s state from cache', uuid, err);
//             return;
//         }

//         if (state) {
//             var fields = state.split(';');
//             var oldZoneState = fields[0];
//             var oldLastModified = new Date(fields[1]);
//             var persisted = fields[2];

//             if (persisted == 'false') {
//                 persisted = false;
//             } else {
//                 persisted = true;
//             }

//             if (!persisted ||
//                 oldZoneState != zoneState ||
//                 oldLastModified < lastModified) {
//                 updateState(persisted);
//             }

//         } else {
//             updateState(false);
//         }
//     }

//     function updateState(p) {
//         vmapi.cache.setVmState(uuid, zoneState, hb[8], server, p, onSetState);
//     }

//     vmapi.cache.getState(uuid, onGetState);
// }



/**
 * Processes a single heartbeat array item
 */
function processDestroyed(vmapi, uuid) {
    vmapi.cache.getVm(uuid, onGetVm);

    function onGetVm(cacheErr, oldVm) {
        if (cacheErr) {
            vmapi.log.error('Error getting VM from cache', cacheErr);
            return;
        }

        if (oldVm) {
            oldVm = common.translateVm(oldVm, true);
            vmapi.napi.deleteNics(oldVm);

            vmapi.ufds.markAsDestroyed(vmapi.cache, oldVm, function (err) {
                onUfdsDestroyed(err, oldVm);
            });

            vmapi.cache.delState(oldVm.uuid, function (err) {
                onStateDeleted(err, oldVm);
            });
        }
    }

    function onUfdsDestroyed(err, oldVm) {
        if (err) {
            vmapi.log.error('Error marking ' + oldVm.uuid +
                            ' as destroyed on UFDS', err);
        } else {
            vmapi.log.info('VM ' + oldVm.uuid + ' marked as destroyed on UFDS');
        }
    }

    function onStateDeleted(err, oldVm) {
        if (err) {
            vmapi.log.error('Error deleting ' + oldVm.uuid +
                            ' state from cache', err);
        } else {
            vmapi.log.info('VM ' + oldVm.uuid + ' state removed from cache');
        }
    }
}



/**
 * Processes a single heartbeat array item
 *
 * 1. Get stored cache state
 * 2. Process state, do we need to invalidate the cache?
 * 3. Update cached state
 * 4. cnapi.getVm
 * 5. Update cached vm
 * 6. Update vm on UFDS
 * 7. Update cached state (mark as added to UFDS)
 * 8. Add NICs to NAPI it they don't exist
 *
 * The 8 steps are only executed when a new or updated machine heartbeat has
 * been received. Most heartbeats won't need to invalidate the cache, so
 * execution can stop at step 2.
 */
function processHeartbeat(vmapi, server, hb) {
    var uuid = hb[1];

    if (uuid == 'global') {
        return;
    }

    vmapi.cache.getState(uuid, onGetState);

    function onGetState(err, state) {
        if (err) {
            vmapi.log.error('Error getting VM %s state from cache', uuid, err);
            return;
        }

        if (state) {
            processState(vmapi, state, uuid, hb[2], hb[8], server);
        } else {
            invalidateCache(vmapi, uuid, hb[2], hb[8], server, false);
        }
    }
}



/*
 * Processes an existing state from the redis cache
 * zoneState is the zone_state in the heartbeat.
 *
 * Cache is invalidated if:
 *
 * - The zone has not been persisted
 * - The zone has changed state
 * - The zone has an updated last_modified timestamp
 */
function processState(vmapi, state, uuid, zoneState, lastModStr, server) {
    var lastModified = new Date(lastModStr);

    // Parse state
    var fields = state.split(';');
    var oldZoneState = fields[0];
    var oldLastModified = new Date(fields[1]);
    var persisted = fields[2];

    if (persisted == 'false') {
        persisted = false;
    } else {
        persisted = true;
    }

    if (!persisted ||
        oldZoneState != zoneState ||
        oldLastModified < lastModified) {
        invalidateCache(vmapi, uuid, zoneState, lastModStr, server, persisted);
    }
}



/*
 * Series of operations to invalidate a VM cache object. By cache we mean redis
 * but we also update UFDS in the process. After updating UFDS we check if the
 * VM NICs exist in NAPI.
 */
function invalidateCache(vmapi, uuid, state, lastMod, server, persisted) {
    async.waterfall([
        setupParams,
        updateStateCache,
        cnapiGetVm,
        updateVmCache,
        updateVmOnUfds,
        markAsAddedToUfds,
        addNicsToNapi
    ], function (err, result) {
        if (err) {
            vmapi.log.error('Error updating cached data for VM %s', uuid, err);
        }
    });

    function setupParams(callback){
        callback(null, vmapi, uuid, state, lastMod, server, persisted);
    }
}

module.exports = Heartbeater;



// Waterfall---

/*
 * Updates the zone state on redids
 */
function updateStateCache(vmapi, uuid, state, lastMod, server, persisted, cb) {
    vmapi.cache.setVmState(uuid, state, lastMod, server, persisted, onSetState);

    function onSetState(err) {
        if (err) {
            vmapi.log.error('Error caching VM state %s %s', uuid, err);
            cb(err);
        } else {
            vmapi.log.debug('VM state cached %s %s %s', uuid, state, lastMod);
            cb(null, vmapi, server, uuid);
        }
    }
}



/*
 * Gets a VM from CNAPI
 */
function cnapiGetVm(vmapi, server, uuid, cb) {
    vmapi.cnapi.getVm(server, uuid, onGetVm);

    function onGetVm(err, vm) {
        if (err) {
            vmapi.log.error('Error talking to CNAPI', err);
            cb(err);
        } else if (vm) {
            cb(null, vmapi, uuid, vm);
        }
    }
}



/*
 * Updates a VM on redis
 */
function updateVmCache(vmapi, uuid, vm, cb) {
    var m = common.translateVm(vm, false);
    vmapi.cache.setVm(uuid, m, onSetVm);

    function onSetVm(err) {
        if (err) {
            vmapi.log.error('Error caching VM %s', uuid, err);
            cb(err);
        } else {
            cb(null, vmapi, m);
        }
    }
}



/*
 * Updates a VM on UFDS
 */
function updateVmOnUfds(vmapi, vm, cb) {
    vmapi.ufds.addUpdateVm(vm, onUfdsAdd);

    function onUfdsAdd(err) {
        if (err) {
            cb(err);
        } else {
            cb(null, vmapi, vm);
        }
    }
}



/*
 * Marks the redis cache state as 'added to UFDS'
 */
function markAsAddedToUfds(vmapi, vm, cb) {
    var stateStamp = vm['zone_state'] + ';' + vm['last_modified'];
    vmapi.cache.setState(vm.uuid, stateStamp, onSetState);

    function onSetState(err) {
        if (err) {
            vmapi.log.error('Error caching VM %s', vm.uuid, err);
            cb(err);
        } else {
            cb(null, vmapi, vm);
        }
    }
}



/*
 * Add NICs to NAPI
 */
function addNicsToNapi(vmapi, vm, cb) {
    // Haven't made this function correctly async yet...
    vmapi.napi.addNics(vm);
    cb(null);
}