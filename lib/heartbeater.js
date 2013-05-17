/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Heartbeat processing library. Its job it's to ensure that VMAPI discovers
 * every VM that lives on a Compute Node and stores their JSON representations
 * on Moray. If the heartbeater doesn't work then VMAPI won't have an up-to-date
 * representation of the VMs in a datacenter (or might not have it at all).
 */

/***************************************************************************
 * IMPORTANT: DO NOT MODIFY THIS FILE IF YOU DON'T KNOW WHAT YOU ARE DOING *
 ***************************************************************************/

var util = require('util');
var amqp = require('./amqp-plus');
var common = require('./common');
var assert = require('assert-plus');
var EventEmitter = require('events').EventEmitter;
var async = require('async');
var restify = require('restify');


/***************************************************************************
 * IMPORTANT: DO NOT MODIFY THIS FILE IF YOU DON'T KNOW WHAT YOU ARE DOING *
 ***************************************************************************/

/*
 * Heartbeater constructor. options is an object with the following properties:
 *  - host: AMQP host
 *  - amqpQueue: AMQP queue. Defaults to 'heartbeat.vmapi'
 *  - log: bunyan logger instance
 */
function Heartbeater(options) {
    assert.object(options, 'amqp options');
    assert.string(options.host, 'amqp options.host');

    this.lastError = null;
    this.lastReceived = null;
    this.lastProcessed = null;
    this.host = options.host;
    this.amqpQueue = options.queue || 'heartbeat.vmapi';
    var log = this.log = options.log;

    // Lets us keep track of known servers so we don't have to ping them when a
    // heartbeat from them is received. Some times heartbeater would send
    // heartbeats from a server when the server doesn't exist yet in CNAPI, this
    // is the case for new servers
    this.servers = {};
    this.napiOnline = false;

    // Simple object to keep track of VM UUIDs being processed at the moment,
    // so that consecutive heartbeats that start to pile up don't get processed.
    // We process one and ignore the rest. For now we don't check the contents
    // of the heartbeat so a fast running-stopped-running transition (i.e. a
    // reboot) might just pass unnoticed by VMAPI
    var processing = this.processing = {};

    // Generic queue definition for processing any task that is passed with a
    // 'run' function. When we process a heartbeat the task will have a uuid
    // that we will use to remove from the processing object
    this.heartbeatQueueSize = options.heartbeatQueueSize || 50;
    this.queue = async.queue(function (task, callback) {
        task.run(function (err) {
            if (task.uuid !== undefined) {
                delete processing[task.uuid];
            }

            callback(err);
        });
    }, this.heartbeatQueueSize);

    this.queue.drain = function() {
        log.trace('Heartbeat queue has been drained');
    };


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

    function onReady() {
        var connection = self.connection;

        self.log.info('Connected to AMQP');
        var queue = connection.queue(self.amqpQueue);

        function onQueueOpen() {
            self.log.debug('Binded queue to exchange');
            queue.bind('heartbeat.*');
            queue.subscribeJSON(onJson);
        }

        function onJson(message, headers, deliveryInfo) {
            assert.object(message, 'amqp message');
            assert.string(deliveryInfo.routingKey, 'amqp routingKey');

            var serverUuid = deliveryInfo.routingKey.split('.')[1];
            self.log.trace({ server: serverUuid }, 'Heartbeat received from %s',
                serverUuid, { headers: headers, deliveryInfo: deliveryInfo });
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
        if (self.servers[serverUuid] && self.napiOnline) {
            // If CNAPI knows about the server and NAPI is online already
            // we can proceed to process heartbeats
            self.processHeartbeats(vmapi, serverUuid, hbs, missing);

        } else {
            vmapi.cnapi.getServer(serverUuid, function (err) {
                if (err) {
                    vmapi.status = vmapi.statuses.NOT_CONNECTED;
                    self.log.error({ err: err, server: serverUuid },
                        'Cannot process heartbeats for Server %s', serverUuid);
                    return;
                }

                self.servers[serverUuid] = true;
                vmapi.napi.ping(function (err2) {
                    if (err2) {
                        vmapi.status = vmapi.statuses.NOT_CONNECTED;
                        self.log.error({ err: err2, server: serverUuid },
                            'Cannot process heartbeats for Server %s',
                            serverUuid);
                        self.napiOnline = false;
                        return;
                    }

                    self.napiOnline = true;
                    self.processHeartbeats(vmapi, serverUuid, hbs, missing);
                });
            });
        }
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
            self.log.error({ err: err, server: server },
                'Could not get list of cached VM UUIDs for server %s', server);
            return cb(err);
        }

        cached.forEach(function (uuid) {
            if (uuids.indexOf(uuid) == -1) {
                missing.push(uuid);
            }
        });
        self.log.trace({ server: server }, 'Missing VMs list for server %s:',
            server, missing);

        var newHash = arrayToHash(uuids);

        return cache.setVmsForServer(server, newHash, function (error) {
            onSaveCache(error, missing);
        });
    }

    function onSaveCache(err, miss) {
        if (err) {
            self.log.error({ err: err, server: server },
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
Heartbeater.prototype.processHeartbeats = function (vmapi, server, vms) {
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
    self.log.trace({ server: server }, 'Current VMs list for server %s:',
        server, uuids);

    function onTaskCompleted(err) {
        self.log.trace('Heartbeat queue task completed');
        // With the first heartbeat processed we know that CNAPI and NAPI
        // are already working and data is being populated correctly
        if (err === undefined && vmapi.status !== vmapi.statuses.OK) {
            vmapi.status = vmapi.statuses.OK;
        }
    }

    var uuid, hb;
    for (var i = 0; i < uuids.length; i++) {
        uuid = uuids[i];
        hb = vms[uuid];

        self.log.trace({ server: server, vm_uuid: uuids[i] },
            'Heartbeat from %s:', uuids[i], vms[uuids[i]]);

        if (uuid !== 'global' && self.processing[uuid] === undefined) {
            self.processing[uuid] = true;
            self.queue.push({
                uuid: uuid,
                run: self.processHeartbeat.bind(self, vmapi, server, hb)
            }, onTaskCompleted);

        } else if (self.processing[uuid] !== undefined) {
            self.log.info({ vm_uuid: uuid }, 'Ignoring heartbeat from VM %s, ' +
                'already processing another heartbeat', uuid, hb);
        }
    }

    self.getMissingUuids(vmapi.cache, server, vms, function (err, missing) {
        if (err) {
            self.log.error(err);
            return;
        }

        for (i = 0; i < missing.length; i++) {
            self.processDestroyed(vmapi, missing[i]);
        }
    });
};



/**
 * Processes a single heartbeat array item
 */
Heartbeater.prototype.processDestroyed = function (vmapi, uuid) {
    var log = this.log;
    vmapi.moray.getVm({ uuid: uuid }, onGetVm);

    function onGetVm(morayErr, oldVm) {
        if (morayErr) {
            log.error({ err: morayErr, vm_uuid: uuid },
                'Error getting VM %s from moray', uuid);
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
            log.error({ err: err, vm_uuid: oldVm.uuid },
                'Error marking % as destroyed', oldVm.uuid);
        } else {
            log.info({ vm_uuid: oldVm.uuid },
                'VM %s marked as destroyed on moray', oldVm.uuid);
        }
    }

    function onStateDeleted(err, oldVm) {
        if (err) {
            log.error({ err: err, vm_uuid: oldVm.uuid },
                'Error deleting VM %s state from cache', oldVm.uuid);
        } else {
            log.info({ vm_uuid: oldVm.uuid },
                'VM %s state removed from cache', oldVm.uuid);
        }
    }

    function onNapiDeleted(err, oldVm) {
        if (err) {
            log.error({ err: err, vm_uuid: oldVm.uuid },
                'Error deleting NICs for VM %s', oldVm.uuid);
        } else {
            log.info({ vm_uuid: oldVm.uuid },
                'NICs for VM %s deleted from NAPI', oldVm.uuid);
        }
    }
};



/**
 * Processes a single heartbeat array item
 *
 * 1. Get stored cache state
 * 2. Process state, do we need to invalidate the cache?
 * 3. cnapi.getVm
 * 4. Update vm on moray
 * 5. Add NICs to NAPI it they don't exist
 *
 * The 5 steps are only executed when a new or updated machine heartbeat has
 * been received. Most heartbeats won't need to invalidate the cache, so
 * execution can stop at step 2.
 */
Heartbeater.prototype.processHeartbeat = function (vmapi, server, hb, cb) {
    var log = this.log;
    var self = this;
    var uuid = hb.uuid;

    vmapi.cache.getState(uuid, onGetState);

    function onGetState(err, stateTimestamp) {
        if (err) {
            log.error({ err: err, vm_uuid: uuid },
                'Error getting VM state from cache');
            return cb(err);
        }

        if (stateTimestamp) {
            self.processState(vmapi, stateTimestamp, uuid, hb, server, cb);
        } else {
            log.trace({ vm_uuid: uuid },
                'No cached stateTimestamp found for VM %s', uuid);
            self.invalidateCache(vmapi, uuid, hb, server, true, true, cb);
        }
    }
};



/*
 * Processes an existing VM state
 * zoneState is the zone_state in the heartbeat.
 *
 * Cache is invalidated if:
 *
 * - The zone has changed state
 * - The zone has an updated last_modified timestamp
 */
Heartbeater.prototype.processState =
function (vmapi, stateTimestamp, uuid, hb, server, cb) {
    var log = this.log;
    var self = this;
    var lastModified = new Date(hb['last_modified']);

    // Parse old state
    var fields = stateTimestamp.split(';');
    var oldState = fields[0];
    var oldLastModified = new Date(fields[1]);
    var oldServer = fields[2];

    log.trace({ vm_uuid: uuid },
        'Timestamps for VM %s, oldLastModified: %s, lastModified: %s',
        uuid, oldLastModified, lastModified);

    if (server !== oldServer) {
        log.error({ vm_uuid: uuid }, 'Found duplicate VM UUIDs. Server from ' +
            'cached data: %s, server from heartbeat: %s, cached status and ' +
            'timestamp: %s;%s, new heartbeat data: %j',
            oldServer, server, oldState, oldLastModified.toISOString(), hb);
    } else if (oldLastModified < lastModified) {
        return self.invalidateCache(vmapi, uuid, hb, server, false, true, cb);
    } else if (oldState != hb.state) {
        return self.invalidateCache(vmapi, uuid, hb, server, false, false, cb);
    }

    return cb();
};



/*
 * Series of operations to update VM object. After updating moray we check if
 * the VM NICs exist in NAPI.
 */
Heartbeater.prototype.invalidateCache =
function (vmapi, uuid, hb, server, newMachine, callCnapi, cb) {
    var log = this.log;
    var self = this;

    // If there was only a state change there is no need to go over then entire
    // waterfall, we only need to update moray
    if (callCnapi === false) {
        self.updateStateOnMoray(vmapi, uuid, hb, server, newMachine, onMoray);
        return;
    }

    // If callCnapi === false then we update redis after updating moray
    function onMoray(err, vmapi2, uuid2, hb2, server2) {
        return self.updateState(vmapi2, uuid2, hb2, null, server2, onError);
    }

    async.waterfall([
        setupParams,
        self.updateStateOnMoray.bind(self),
        self.cnapiGetVm.bind(self),
        self.updateVmOnMoray.bind(self),
        self.addNicsToNapi.bind(self),
        self.updateState.bind(self)
    ], onError);

    function setupParams(callback) {
        callback(null, vmapi, uuid, hb, server, newMachine);
    }

    function onError(err, result) {
        if (err) {
            vmapi.heartbeater.lastError = err;
            log.error({ err: err, vm_uuid: uuid },
                'Error invalidating cache state of VM %s', uuid);
        } else {
            log.debug({ vm_uuid: uuid },
                'Cache state of VM %s has been updated', uuid);
            vmapi.heartbeater.lastError = null;
            vmapi.heartbeater.lastProcessed = {
                timestamp: new Date(),
                server: server,
                uuid: uuid
            };
        }

        return cb(err);
    }
};



module.exports = Heartbeater;



// Waterfall---


/*
 * Updates the VM state on moray. This is called before putting the entire new
 * VM object to save time while waiting for cnapi.getVm to return
 */
Heartbeater.prototype.updateStateOnMoray =
function (vmapi, uuid, hb, server, newMachine, cb) {
    var log = this.log;

    if (newMachine) {
        log.info({ vm_uuid: uuid }, 'New VM %s, skipping updateState', uuid);
        cb(null, vmapi, uuid, hb, server);
        return;
    }

    vmapi.moray.updateState(uuid, hb, onUpdate);

    function onUpdate(err) {
        if (err) {
            log.error({ err: err, vm_uuid: uuid },
                'Error updating VM %s state on moray', uuid);
            cb(err);
        } else {
            log.debug({ vm_uuid: uuid },
            'Heartbeat data of VM %s updated on moray', uuid, hb);
            cb(null, vmapi, uuid, hb, server);
        }
    }
};



/*
 * Gets a VM from CNAPI
 */
Heartbeater.prototype.cnapiGetVm = function (vmapi, uuid, hb, server, cb) {
    var log = this.log;
    vmapi.cnapi.getVm(server, uuid, false, onGetVm);

    function onGetVm(err, vm) {
        if (err) {
            log.error({ err: err, vm_uuid: uuid }, 'Error talking to CNAPI');
            cb(err);
        } else if (vm) {
            log.trace({ vm_uuid: uuid },
                'CNAPI replied with data for VM %s', uuid, vm);
            cb(null, vmapi, uuid, hb, vm, server);
        } else {
            var err2 = new Error('Unexpected response received from CNAPI');
            log.error({ vm_uuid: uuid, server: server },
                'Unexpected response received from CNAPI');
            cb(err2);
        }
    }
};



/*
 * Updates a VM on moray
 */
Heartbeater.prototype.updateVmOnMoray =
function (vmapi, uuid, hb, vm, server, cb) {
    var log = this.log;
    var m = common.translateVm(vm, false);

    // There might be a difference between the heartbeat and the state that
    // CNAPI reports, the state that cnapi reported is newer than the heartbeat.
    hb.state = m.state;
    hb['zone_state'] = m['zone_state'];

    vmapi.moray.putVm(uuid, m, onPutVm);

    function onPutVm(err) {
        if (err) {
            log.error({ err: err, vm_uuid: uuid }, 'Error storing VM on moray');
            cb(err);
        } else {
            log.debug({ vm_uuid: uuid }, 'VM object %s updated on moray', uuid);
            cb(null, vmapi, uuid, hb, vm, server);
        }
    }
};



/*
 * Add NICs to NAPI
 */
Heartbeater.prototype.addNicsToNapi =
function (vmapi, uuid, hb, vm, server, cb) {
    var log = this.log;

    vmapi.napi.addNics(vm, { check_owner: false }, function (err) {
        if (err) {
            log.error({ err: err, vm_uuid: vm.uuid },
                'Error adding NICs for VM %s', vm.uuid);
            cb(err);
        } else {
            log.debug({ vm_uuid: vm.uuid }, 'NICs added for VM %s', vm.uuid);
            cb(null, vmapi, uuid, hb, vm, server);
        }
    });
};



/*
 * Updates the zone state on redids
 */
Heartbeater.prototype.updateState = function (vmapi, uuid, hb, vm, server, cb) {
    var log = this.log;
    vmapi.cache.setState(uuid, hb, server, onSetState);

    function onSetState(err) {
        if (err) {
            log.error({ err: err, vm_uuid: uuid }, 'Error caching VM state');
            cb(err);
        } else {
            log.debug({ vm_uuid: uuid }, 'VM %s state cached', uuid, hb);
            cb(null);
        }
    }
};