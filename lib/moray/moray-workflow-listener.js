/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

var events = require('events');
var util = require('util');

var assert = require('assert-plus');


/*
 * Globals.
 */

const IDLE_TEARDOWN_MS = 30000; // 30 seconds
var UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const WORKFLOW_STATUS_CHANNEL = 'workflow_job_status_changed';

/*
 * MorayWorkflowListener module constructor that takes an options object.
 *
 * Example options object:
 *
 * var options = {
 *     log: new Bunyan({name: 'logger'}),
 *     morayClient: moray.createClient(),
 *     restifyServer: server
 * };
 */
function MorayWorkflowListener(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.morayClient, 'opts.morayClient');
    assert.optionalObject(opts.restifyServer, 'opts.restifyServer');

    // Parent constructor.
    events.EventEmitter.call(this);

    // Option variables.
    this.log = opts.log.child({component: 'moray-workflow-listener'});

    this.wf_morayClient = opts.morayClient;

    // Helper variables.
    this.wf_handlersByJobUuid = {};
    this.wf_listenerCount = 0;
    this.wf_morayListener = null;
    this.wf_idleTimeout = -1;

    // Event listeners.
    this.wf_onListenerAddedFunc = this.onListenerAdded.bind(this);
    this.wf_onListenerRemovedFunc = this.onListenerRemoved.bind(this);
    this.wf_onListenerErrorFunc = this.onListenerError.bind(this);
    this.wf_onListenerEndFunc = this.onListenerEnd.bind(this);
    this.wf_onReadableFunc = this.onReadable.bind(this);
    this.on('newListener', this.wf_onListenerAddedFunc);
    this.on('removeListener', this.wf_onListenerRemovedFunc);

    // Register restify routes.
    if (opts && opts.restifyServer) {
        this.mountRestifyServerRoutes(opts.restifyServer);
    }

    this.log.info('initialized');
}
util.inherits(MorayWorkflowListener, events.EventEmitter);

// Start out with the listener being supported, but if the Moray server
// does not support listen, then this will be set to false.
MorayWorkflowListener.isListenSupported = true;

MorayWorkflowListener.prototype._setupMorayListener =
function _wf_setupMorayListener() {
    var log = this.log;

    if (!MorayWorkflowListener.isListenSupported) {
        log.info('moray.listen is not supported');
        this.wf_morayListener = null;
        return;
    }

    this.wf_morayListener = this.wf_morayClient.listen(WORKFLOW_STATUS_CHANNEL);

    // Event handlers.
    this.wf_morayListener.once('end', this.wf_onListenerEndFunc);
    this.wf_morayListener.once('error', this.wf_onListenerErrorFunc);
    this.wf_morayListener.on('readable', this.wf_onReadableFunc);

    log.info({id: this.wf_morayListener.req_id}, 'started listener');
};

MorayWorkflowListener.prototype.onListenerAdded =
function _wf_listenerAdd(jobUuid, handlerFunc) {
    var log = this.log;

    if (!jobUuid.match(UUID_RE)) {
        log.trace({job_uuid: jobUuid}, 'add listener called without a uuid');
        return;
    }

    assert.func(handlerFunc, 'handlerFunc');

    this.wf_listenerCount += 1;

    // Store the handler for this job (associated with the job uuid).
    if (!this.wf_handlersByJobUuid.hasOwnProperty(jobUuid)) {
        this.wf_handlersByJobUuid[jobUuid] = [handlerFunc];
    } else {
        assert.arrayOfFunc(this.wf_handlersByJobUuid[jobUuid],
            'this.wf_handlersByJobUuid[jobUuid]');
        this.wf_handlersByJobUuid[jobUuid].push(handlerFunc);
    }

    if (this.wf_listenerCount > 1) {
        // Already have (or tried to) setup the listener - nothing to do.
        return;
    }

    // This is the first listener, setup the moray listen handle, which will
    // be kept around until there are no more workflow job listeners.

    if (this.wf_morayListener) {
        // There is already a listen handle (it's just idle), nothing to do.
        log.info('first listener - already listening');
        clearTimeout(this.wf_idleTimeout);
        this.wf_idleTimeout = -1;
        return;
    }

    this._setupMorayListener();
};

MorayWorkflowListener.prototype.onListenerRemoved =
function _wf_listenerRemoved(jobUuid, handlerFunc) {
    var log = this.log;

    if (!jobUuid.match(UUID_RE)) {
        log.trace({job_uuid: jobUuid}, 'remove listener called without a uuid');
        return;
    }

    assert.func(handlerFunc, 'handlerFunc');

    if (!this.wf_handlersByJobUuid.hasOwnProperty(jobUuid)) {
        log.debug({job_uuid: jobUuid}, 'removeListener: jobUuid not found');
        return; // Not such event listener.
    }

    assert.arrayOfFunc(this.wf_handlersByJobUuid[jobUuid],
        'this.wf_handlersByJobUuid[jobUuid]');

    var handlers = this.wf_handlersByJobUuid[jobUuid];
    var idx = handlers.indexOf(handlerFunc);
    if (idx === -1) {
        log.debug({job_uuid: jobUuid}, 'removeListener: handler not found');
        return; // Not such event listener.
    }

    this.wf_listenerCount -= 1;
    // Remove the listener.
    handlers.splice(idx, 1);

    // On the last listener, we setup a timeout which will tear down the
    // moray listen handle (if nothing else has requested to listen for
    // workflow job updates).
    if (this.wf_listenerCount === 0) {
        log.info('no listeners left, setting idle timer');

        this.wf_idleTimeout = setTimeout(this.teardownMorayListener.bind(this),
            IDLE_TEARDOWN_MS);
    }
};

MorayWorkflowListener.prototype.onListenerError =
function _wf_listenerError(err) {
    this.log.warn('Listen error: %s', err);
    if (err && err.message && err.message.includes('unsupported RPC method')) {
        this.wf_morayListener.unlisten = null;
        MorayWorkflowListener.isListenSupported = false;
    }
    this.teardownMorayListener();
};

MorayWorkflowListener.prototype.onListenerEnd = function _wf_listenerEnd() {
    this.log.debug('Listen end');
    this.teardownMorayListener();
};

MorayWorkflowListener.prototype.onNotification =
function _wf_onNotification(notification) {
    assert.object(notification, 'notification');

    var event;
    var log = this.log;

    if (this.wf_listenerCount === 0) {
        // When there are no listeners (idle) then there is nothing to be done.
        log.debug('no listeners - ignoring notification');
        return;
    }

    // Parse the notification payload (JSON).
    try {
        event = JSON.parse(notification.payload);
    } catch (ex) {
        log.warn({notification: notification},
            'unable to parse notification payload');
        return;
    }

    log.info({event: event}, 'got a notification event');

    // Get the array of listeners for this job.
    var jobUuid = event.uuid;
    var handlers = this.wf_handlersByJobUuid[jobUuid];

    if (!Array.isArray(handlers) || handlers.length === 0) {
        log.debug({job_uuid: jobUuid}, 'no listeners for job');
        return;
    }

    // Notify all listeners of the job change.
    handlers.forEach(function _wf_listenerEachHandler(handlerFunc) {
        try {
            log.debug({job_uuid: jobUuid}, 'sending job update to handler');
            handlerFunc(event);
        } catch (ex) {
            log.error({job_uuid: jobUuid}, 'notify error: ' + ex + '\n' +
                ex.stack);
        }
    });
};

MorayWorkflowListener.prototype.onReadable = function _wf_onReadable() {
    var data = this.wf_morayListener.read();
    while (data) {
        this.onNotification(data);
        data = this.wf_morayListener.read();
    }
};

MorayWorkflowListener.prototype.teardownMorayListener =
function _wf_teardownMorayListener() {
    var listener = this.wf_morayListener;
    var log = this.log;

    if (!listener) {
        log.trace('teardown moray listener: no listener, nothing to do');
        return;
    }

    log.info('ending the moray listen call');

    // Remove event listeners.
    listener.removeListener('error', this.wf_onListenerErrorFunc);
    listener.removeListener('end', this.wf_onListenerEndFunc);
    listener.removeListener('readable', this.wf_onReadableFunc);

    if (listener.unlisten) {
        assert.func(listener.unlisten, 'listener.unlisten');
        log.info('calling unlisten');

        listener.unlisten(function _unlistenCb(err) {
            if (err) {
                log.error({id: listener.req_id}, 'Unlisten failure:', err);
            }
        });

        listener.unlisten = null;
    }

    this.wf_morayListener = null;
};


/*
 * Sets up the restify handlers to retrieve stats.
 *
 * @params {Object} restifyServer - A restify server instance
 */
MorayWorkflowListener.prototype.mountRestifyServerRoutes =
function wfl_mountRestifyServerRoutes(restifyServer) {
    assert.object(restifyServer, 'restifyServer');

    restifyServer.get({
        name: 'workflow_listener_stats',
        path: '/workflowlistener/stats'
    }, this._getStats.bind(this));

    restifyServer.log.info('Mounted moray workflow listener endpoints');
};


MorayWorkflowListener.prototype._getStats = function _getStats(req, res, next) {
    var status = 'stopped';
    if (this.wf_morayListener) {
        if (this.wf_idleTimeout !== -1) {
            status = 'listening';
        } else {
            status = 'idle';
        }
    }

    var stats = {
        numListeners: this.wf_listenerCount,
        jobs: Object.keys(this.wf_handlersByJobUuid),
        status: status
    };

    res.send(stats);
    next();
};

module.exports = MorayWorkflowListener;
