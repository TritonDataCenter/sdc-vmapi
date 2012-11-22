/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var util = require('util');
var amqp = require('./amqp-plus');
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

    this.lastReceived = null;
    this.lastProcessed = null;
    this.host = options.host;
    this.queue = options.queue || 'heartbeat.vmapi';
    this.log = options.log;

    EventEmitter.call(this);
}

util.inherits(Heartbeater, EventEmitter);



/*
 * Connects to the AMQP host
 */
Heartbeater.prototype.connect = function (cb) {
    return attemptConnect.call(this, cb);
};



/*
 * Connection attempt function
 */
function attemptConnect(cb) {
    var self = this;

    this.connection = amqp.createConnection({ host: this.host },
        { log: self.log });
    this.connection.on('ready', onReady);
    this.connection.reconnect();

    function onReady () {
        var connection = self.connection;

        self.log.info('Connected to AMQP');
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
        return cb();
    }
}



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
 * Sets the listener for heartbeats
 */
Heartbeater.prototype.listen = function (vmapi, cb) {
    var self = this;

    self.on('heartbeat', function (serverUuid, hbs, missing) {
        self.processHeartbeats(vmapi, serverUuid, hbs, missing);
    });

    return cb();
};



/*
 * Compares the new set of UUIDs with the previously cached. If there are
 * missing UUIDs we can assume the vm was destroyed and proceed to mark as
 * destroyed on moray. This function reads server-vms hash on redis, which holds
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

    cache.getVmsForServer(server, onCache);

    function onCache(err, cached) {
        if (err) {
            self.log.error(
                'Could not get list of cached VM UUIDs for server %s', server);
            return cb(err);
        }

        cached.forEach(function (uuid) {
            if (uuids.indexOf(uuid) == -1) {
                missing.push(uuid);
            }
        });

        var newHash = arrayToHash(uuids);

        return cache.setVmsForServer(server, newHash, function (error) {
            onSaveCache(error, missing);
        });
    }

    function onSaveCache(err, miss) {
        if (err) {
            self.log.error(
                'Could not cache list VM UUIDs for server %s', server);
            return cb(err);
        }

        return cb(null, miss);
    }
};



/*
 * Process each heartbeat. For each heartbeat we need to check if the vm
 * exists and create it on moray if they don't
 *
 * Sample heartbeat:
 *    ID   zonename  status
 *   [ 0, 'global', 'running', '/', '', 'liveimg', 'shared', '0'
 */
function processHeartbeats(vmapi, server, hbs) {
    var self = this;

    this.lastReceived = {
        timestamp: new Date(),
        server: server
    };

    if (!vmapi.cache.connected()) {
        self.log.error('Cannot process heartbeats without connection to Redis');
        return;
    }

    for (var i = 0; i < hbs.length; i++) {
        processHeartbeat(vmapi, server, hbs[i]);
    }

    self.getMissingUuids(vmapi.cache, server, hbs, function (err, missing) {
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
 * Processes a single heartbeat array item
 */
function processDestroyed(vmapi, uuid) {
    vmapi.moray.getVm({ uuid: uuid }, onGetVm);

    function onGetVm(morayErr, oldVm) {
        if (morayErr) {
            vmapi.log.error('Error getting VM from moray', morayErr);
            return;
        }

        if (oldVm) {
            oldVm = common.translateVm(oldVm, false);
            vmapi.napi.deleteNics(oldVm);

            vmapi.moray.markAsDestroyed(oldVm, function (err) {
                onMorayDestroyed(err, oldVm);
            });

            vmapi.cache.delState(oldVm.uuid, function (err) {
                onStateDeleted(err, oldVm);
            });
        }
    }

    function onMorayDestroyed(err, oldVm) {
        if (err) {
            vmapi.log.error('Error marking ' + oldVm.uuid +
                    'as destroyed on moray', err);
        } else {
            vmapi.log.info('VM ' + oldVm.uuid +
                    ' marked as destroyed on moray');
        }
    }

    function onStateDeleted(err, oldVm) {
        if (err) {
            /*JSSTYLED*/
            vmapi.log.error('Error deleting ' + oldVm.uuid + ' state from cache', err);
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
 * 3. cnapi.getVm
 * 4. Update vm on moray
 * 5. Update cached state
 * 6. Add NICs to NAPI it they don't exist
 * 7. Cleanup cache if machine was in a 'provisioning' state
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
            var newStateStamp = hb[2] + ';' + hb[8];
            invalidateCache(vmapi, uuid, newStateStamp, server);
        }
    }
}



/*
 * Processes an existing state from the redis cache
 * zoneState is the zone_state in the heartbeat.
 *
 * Cache is invalidated if:
 *
 * - The zone has changed state
 * - The zone has an updated last_modified timestamp
 */
function processState(vmapi, state, uuid, zoneState, lastModStr, server) {
    var lastModified = new Date(lastModStr);

    // Parse state
    var fields = state.split(';');
    var oldZoneState = fields[0];
    var oldLastModified = new Date(fields[1]);
    // New state stamp -> running;timestamp
    var newStateStamp = zoneState + ';' + lastModStr;

    if (oldZoneState != zoneState ||
        oldLastModified < lastModified) {
        invalidateCache(vmapi, uuid, newStateStamp, server);
    }
}



/*
 * Series of operations to update VM object. After updating moray we check if
 * the VM NICs exist in NAPI.
 */
function invalidateCache(vmapi, uuid, stateStamp, server) {
    async.waterfall([
        setupParams,
        cnapiGetVm,
        updateVmOnMoray,
        updateState,
        addNicsToNapi,
        cleanupCache
    ], function (err, result) {
        if (err) {
            vmapi.log.error('Error updating cached data for VM %s', uuid, err);
        }

        vmapi.heartbeater.lastProcessed = {
            timestamp: new Date(),
            server: server,
            uuid: uuid
        };
    });

    function setupParams(callback) {
        callback(null, vmapi, uuid, stateStamp, server);
    }
}

module.exports = Heartbeater;



// Waterfall---


/*
 * Gets a VM from CNAPI
 */
function cnapiGetVm(vmapi, uuid, stateStamp, server, cb) {
    vmapi.cnapi.getVm(server, uuid, onGetVm);

    function onGetVm(err, vm) {
        if (err) {
            vmapi.log.error('Error talking to CNAPI', err);
            cb(err);
        } else if (vm) {
            cb(null, vmapi, uuid, stateStamp, vm);
        }
    }
}



/*
 * Updates a VM on moray
 */
function updateVmOnMoray(vmapi, uuid, stateStamp, vm, cb) {
    var m = common.translateVm(vm, false);
    vmapi.moray.putVm(uuid, m, onPutVm);

    function onPutVm(err) {
        if (err) {
            vmapi.log.error('Error storing VM %s on moray', uuid, err);
            cb(err);
        } else {
            cb(null, vmapi, uuid, stateStamp, vm);
        }
    }
}



/*
 * Updates the zone state on redids
 */
function updateState(vmapi, uuid, stateStamp, vm, cb) {
    vmapi.cache.setState(uuid, stateStamp, onSetState);

    function onSetState(err) {
        if (err) {
            vmapi.log.error('Error caching VM state %s', uuid, err);
            cb(err);
        } else {
            vmapi.log.debug('VM state cached %s %s', uuid, stateStamp);
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
    cb(null, vmapi, vm);
}



/*
 * Cleans up a machine if it was stored in the cache as 'provisioning'
 */
function cleanupCache(vmapi, vm, cb) {
    cb(null);
    // vmapi.cache.getVm(vm.uuid, onGetVm);

    function onGetVm(err, cached) {
        if (err) {
            vmapi.log.error('Error fetching cached vm %s', vm.uuid);
            cb(err);
        }

        // If it exists delete it
        if (cached) {
            vmapi.cache.delVm(vm.uuid, onDelVm);
        } else {
            cb(null);
        }
    }

    function onDelVm(err) {
        if (err) {
            vmapi.log.error('Error removing vm %s from cache', vm.uuid);
            cb(err);
        } else {
            cb(null);
        }
    }
}
