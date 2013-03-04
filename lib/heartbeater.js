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
var restify = require('restify');



/*
 * Heartbeater constructor. options is an object with the following properties:
 *  - host: AMQP host
 *  - queue: AMQP queue. Defaults to 'heartbeat.vmapi'
 *  - log: bunyan logger instance
 */
function Heartbeater(options) {
    assert.object(options, 'amqp options');
    assert.string(options.host, 'amqp options.host');

    this.lastError = null;
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
            self.emit('heartbeat', serverUuid, message.vms);
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
Heartbeater.prototype.getMissingUuids = function (cache, server, vms, cb) {
    var self = this;
    var missing = [];
    var uuids = Object.keys(vms);

    cache.getVmsForServer(server, onCache);

    function onCache(err, cached) {
        if (err) {
            self.log.error(err,
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
            self.log.error(err,
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
 *
 *  { '085deccd-c418-427d-9075-deee13c2daaa':
 *     { uuid: '085deccd-c418-427d-9075-deee13c2daaa',
 *       owner_uuid: '00000000-0000-0000-0000-000000000000',
 *       quota: 10,
 *       max_physical_memory: 1024,
 *       zone_state: 'running',
 *       state: 'running',
 *       last_modified: '2012-11-26T05:27:32.000Z' },
 */
function processHeartbeats(vmapi, server, vms) {
    var self = this;
    var error;

    this.lastReceived = {
        timestamp: new Date(),
        server: server
    };

    if (!vmapi.cache.connected()) {
        error = new restify.InternalError('Cannot process heartbeats without ' +
                            ' connection to Redis');
        self.log.error(error);
        self.lastError = error;
        return;
    }

    if (vmapi.moray.connected !== true) {
        error = new restify.InternalError('Cannot process heartbeats without ' +
                            'connection to Moray');
        self.log.error(error);
        self.lastError = error;
        return;
    }

    self.lastError = null;

    var uuids = Object.keys(vms);

    for (var i = 0; i < uuids.length; i++) {
        processHeartbeat(vmapi, server, vms[uuids[i]]);
    }

    self.getMissingUuids(vmapi.cache, server, vms, function (err, missing) {
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
    vmapi.moray.getVm({ vm_uuid: uuid }, onGetVm);

    function onGetVm(morayErr, oldVm) {
        if (morayErr) {
            vmapi.log.error(morayErr, 'Error getting VM from moray');
            return;
        }

        if (oldVm) {
            oldVm = common.translateVm(oldVm, false);
            vmapi.napi.deleteNics(oldVm, function (err) {
                onNapiDeleted(err, oldVm);
            });

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
            vmapi.log.error(err, 'Error marking % as destroyed', oldVm.uuid);
        } else {
            vmapi.log.info('VM %s marked as destroyed on moray', oldVm.uuid);
        }
    }

    function onStateDeleted(err, oldVm) {
        if (err) {
            vmapi.log.error(err, 'Error deleting %s state from cache',
                oldVm.uuid);
        } else {
            vmapi.log.info('VM %s state removed from cache', oldVm.uuid);
        }
    }

    function onNapiDeleted(err, oldVm) {
        if (err) {
            vmapi.log.error(err, 'Error deleting NICs for VM %s', oldVm.uuid);
        } else {
            vmapi.log.info('NICs for VM %s deleted from NAPI', oldVm.uuid);
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
    var uuid = hb.uuid;

    if (uuid == 'global') {
        return;
    }

    vmapi.cache.getState(uuid, onGetState);

    function onGetState(err, stateTimestamp) {
        if (err) {
            vmapi.log.error({ err: err, vm_uuid: uuid },
                'Error getting VM state from cache');
            return;
        }

        if (stateTimestamp) {
            processState(vmapi, stateTimestamp, uuid, hb, server);
        } else {
            invalidateCache(vmapi, uuid, hb, server, true, true);
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
function processState(vmapi, stateTimestamp, uuid, hb, server) {
    var lastModified = new Date(hb['last_modified']);

    // Parse old state
    var fields = stateTimestamp.split(';');
    var oldState = fields[0];
    var oldLastModified = new Date(fields[1]);

    if (oldLastModified < lastModified) {
        invalidateCache(vmapi, uuid, hb, server, false, true);
    } else if (oldState != hb.state) {
        invalidateCache(vmapi, uuid, hb, server, false, false);
    }
}



/*
 * Series of operations to update VM object. After updating moray we check if
 * the VM NICs exist in NAPI.
 */
function invalidateCache(vmapi, uuid, hb, server, newMachine, callCnapi) {
    // If there was only a state change there is no need to go over then entire
    // waterfall, we only need to update moray
    if (callCnapi === false) {
        updateStateOnMoray(vmapi, uuid, hb, server, newMachine, onMoray);
        return;
    }

    // If callCnapi === false then we update redis after updating moray
    function onMoray(err, vmapi, uuid, hb, server) {
        return updateState(vmapi, uuid, hb, null, onError);
    }

    async.waterfall([
        setupParams,
        updateStateOnMoray,
        cnapiGetVm,
        updateVmOnMoray,
        updateState,
        addNicsToNapi,
        cleanupCache
    ], onError);

    function setupParams(callback) {
        callback(null, vmapi, uuid, hb, server, newMachine);
    }

    function onError(err, result) {
        if (err) {
            vmapi.heartbeater.lastError = err;
            vmapi.log.error({ err: err, vm_uuid: uuid },
                'Error invalidating cache state of VM');
        } else {
            vmapi.heartbeater.lastError = null;
            vmapi.heartbeater.lastProcessed = {
                timestamp: new Date(),
                server: server,
                uuid: uuid
            };
        }
    }
}

module.exports = Heartbeater;



// Waterfall---


/*
 * Updates the VM state on moray. This is called before putting the entire new
 * VM object to save time while waiting for cnapi.getVm to return
 */
function updateStateOnMoray(vmapi, uuid, hb, server, newMachine, cb) {
    if (newMachine) {
        vmapi.log.debug('New VM %s, skipping updateState', uuid);
        cb(null, vmapi, uuid, hb, server);
        return;
    }

    vmapi.moray.updateState(uuid, hb, onUpdate);

    function onUpdate(err) {
        if (err) {
            vmapi.log.error({ err: err, vm_uuid: uuid },
                'Error updating VM state on moray');
            cb(err);
        } else {
            vmapi.log.debug('State of VM %s updated on moray to', uuid, hb);
            cb(null, vmapi, uuid, hb, server);
        }
    }
}



/*
 * Gets a VM from CNAPI
 */
function cnapiGetVm(vmapi, uuid, hb, server, cb) {
    vmapi.cnapi.getVm(server, uuid, false, onGetVm);

    function onGetVm(err, vm) {
        if (err) {
            vmapi.log.error({ err: err, vm_uuid: uuid },
                'Error talking to CNAPI');
            cb(err);
        } else if (vm) {
            cb(null, vmapi, uuid, hb, vm);
        }
    }
}



/*
 * Updates a VM on moray
 */
function updateVmOnMoray(vmapi, uuid, hb, vm, cb) {
    var m = common.translateVm(vm, false);
    // There might be a difference between the heartbeat and the state that
    // CNAPI reports, the state that cnapi reported is newer than the heartbeat.
    hb.state = m.state;
    hb['zone_state'] = m['zone_state'];

    vmapi.moray.putVm(uuid, m, onPutVm);

    function onPutVm(err) {
        if (err) {
            vmapi.log.error({ err: err, vm_uuid: uuid },
                'Error storing VM on moray');
            cb(err);
        } else {
            vmapi.log.debug('VM object %s updated on moray', uuid);
            cb(null, vmapi, uuid, hb, vm);
        }
    }
}



/*
 * Updates the zone state on redids
 */
function updateState(vmapi, uuid, hb, vm, cb) {
    vmapi.cache.setState(uuid, hb, onSetState);

    function onSetState(err) {
        if (err) {
            vmapi.log.error({ err: err, vm_uuid: uuid },
                'Error caching VM state');
            cb(err);
        } else {
            vmapi.log.debug('VM state cached', hb);
            cb(null, vmapi, vm);
        }
    }
}



/*
 * Add NICs to NAPI
 */
function addNicsToNapi(vmapi, vm, cb) {
    vmapi.napi.addNics(vm, function (err) {
        if (err) {
            vmapi.log.error({ err: err, vm_uuid: uuid }, 'Error adding NICs');
            cb(err);
        } else {
            vmapi.log.debug({ vm_uuid: uuid }, 'NIC added for VM');
            cb(null, vmapi, vm);
        }
    });
}



/*
 * Cleans up a machine if it was stored in the cache as 'provisioning'
 */
function cleanupCache(vmapi, vm, cb) {
    vmapi.cache.getVm(vm.uuid, onGetVm);

    function onGetVm(err, cached) {
        if (err) {
            vmapi.log.error(err, 'Error fetching cached vm %s', vm.uuid);
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
            vmapi.log.error(err, 'Error removing vm %s from cache', vm.uuid);
            cb(err);
        } else {
            cb(null);
        }
    }
}
