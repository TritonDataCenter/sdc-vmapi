/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * This contains the functions for talking to the workflow API.
 */

var assert = require('assert-plus');
var async = require('async');
var sprintf = require('sprintf').sprintf;
var uuid = require('libuuid');
var WfClient = require('wf-client');

var common = require('./../common');
var clone = common.clone;


// Workflows

// Absolute path from the app
var WORKFLOW_PATH = './lib/workflows/';


/*
 * WFAPI Constructor
 */
function Wfapi(options) {
    this.log = options.log;
    options.path = WORKFLOW_PATH;

    this.client = new WfClient(options);
    this.connected = false;
    this.url = options.url;
}



/*
 * Wait until wfapi is online before proceeding to create workflows
 */
Wfapi.prototype.connect = function connect() {
    var self = this;
    self.log.debug('Loading the WFAPI workflows...');

    self.startAvailabilityWatcher();

    // Don't proceed with initializing workflows until we have connected.
    function init() {
        async.until(
            function () { return self.connected; },
            function (cb) {
                setTimeout(cb, 1000);
            },
            function () {
                self.client.initWorkflows(function (error) {
                    if (error) {
                        self.log.error(error, 'Error initializing workflows');
                        init();
                    } else {
                        self.log.info('All workflows have been loaded');
                    }
                });
            });
    }

    init();
};



/*
 * Ping until wfapi is online
 */
Wfapi.prototype.startAvailabilityWatcher = function () {
    var self = this;

    setInterval(function () {
        pingWorkflow();
    }, 10000);

    function pingWorkflow() {
        var client = self.client;

        // Try to get a fake workflow, check the error code if any.
        client.ping(function (error) {
            if (error) {
                if (self.connected) {
                    self.log.error('Workflow appears to be unavailable');
                }

                if (error.syscall === 'connect') {
                    self.connected = false;
                    self.log.error(
                        'Failed to connect to Workflow API (%s)', error.code);
                    return;
                }

                self.connected = false;
                self.log.error({ error: error }, 'Ping failed');

                return;
            }

            if (!self.connected) {
                client.getWorkflow(
                    'workflow-check',
                    function (err, val) {
                        if (err.statusCode !== 404)
                        {
                            self.log.warn(err,
                                'Workflow API Error: %d',
                                err.statusCode);
                            return;
                        }
                        if (!self.connected) {
                            self.connected = true;
                            self.log.info('Connected to Workflow API');
                        }
                    });
            }
        });
    }

    pingWorkflow();
};



/*
 * Pings WFAPI by getting the provision workflow
 */
Wfapi.prototype.ping = function (callback) {
    this.client.ping(function (err, pong) {
        return callback(err);
    });
};



/*
 * Queues a provision job.
 */
Wfapi.prototype.createProvisionJob = function (req, cb) {
    var self = this;
    var params = clone(req.params);
    var vm_uuid = params.uuid;
    var options = { headers: { 'x-request-id': req.getId() } };

    params.task = 'provision';
    params.target = '/provision-' + vm_uuid;
    params.vm_uuid = vm_uuid;
    params.current_state = 'provisioning';
    params['x-request-id'] = req.getId();
    delete params.uuid;

    setContext(req, params);

    if (req.params.creator_uuid !== undefined)
        params.creator_uuid = req.params.creator_uuid;
    if (req.params.origin !== undefined)
        params.origin = req.params.origin;

    self.client.createJob('provision', params, options, function (err, job) {
        if (err) {
            cb(err);
            return;
        }

        self.log.debug('Provision job ' + job.uuid + ' queued for VM ' +
            vm_uuid);
        cb(null, vm_uuid, job.uuid);
    });
};



/*
 * Queues a start job.
 */
Wfapi.prototype.createStartJob = function (req, cb) {
    var self = this;
    var vm_uuid = req.vm.uuid;
    var params = {};
    var options = { headers: { 'x-request-id': req.getId() } };

    params.task = 'start';
    params.target = '/start-' + vm_uuid;
    params.vm_uuid = vm_uuid;
    params.owner_uuid = req.vm.owner_uuid;
    params.server_uuid = req.vm.server_uuid;
    params.current_state = req.vm.state;
    params['x-request-id'] = req.getId();

    setContext(req, params);

    if (req.params.creator_uuid !== undefined)
        params.creator_uuid = req.params.creator_uuid;
    if (req.params.origin !== undefined)
        params.origin = req.params.origin;
    if (req.params.update !== undefined)
        params.update = req.params.update;

    if (req.params['idempotent']) {
        params.idempotent = req.params['idempotent'];
    }

    self.client.createJob('start', params, options, function (err, job) {
        if (err) {
            cb(err);
            return;
        }

        self.log.debug('Start job ' + job.uuid + ' queued for VM ' + vm_uuid);
        cb(null, job.uuid);
    });
};



/*
 * Queues a stop job.
 */
Wfapi.prototype.createStopJob = function (req, cb) {
    var self = this;
    var vm_uuid = req.vm.uuid;
    var params = {};
    var options = { headers: { 'x-request-id': req.getId() } };

    params.task = 'stop';
    params.target = '/stop-' + vm_uuid;
    params.vm_uuid = vm_uuid;
    params.owner_uuid = req.vm.owner_uuid;
    params.server_uuid = req.vm.server_uuid;
    params.current_state = req.vm.state;
    params['x-request-id'] = req.getId();

    setContext(req, params);

    if (req.params.creator_uuid !== undefined)
        params.creator_uuid = req.params.creator_uuid;
    if (req.params.origin !== undefined)
        params.origin = req.params.origin;
    if (req.params.timeout !== undefined)
        params.timeout = req.params.timeout;

    if (req.params['idempotent']) {
        params.idempotent = req.params['idempotent'];
    }

    self.client.createJob('stop', params, options, function (err, job) {
        if (err) {
            cb(err);
            return;
        }

        self.log.debug('Stop job ' + job.uuid + ' queued for VM ' + vm_uuid);
        cb(null, job.uuid);
    });
};



/*
 * Queues a kill job.
 */
Wfapi.prototype.createKillJob = function (req, cb) {
    var self = this;
    var vm_uuid = req.vm.uuid;
    var params = {};
    var options = { headers: { 'x-request-id': req.getId() } };

    if (req.params['signal']) {
        params.signal = req.params['signal'];
    }

    if (req.params['idempotent']) {
        params.idempotent = req.params['idempotent'];
    }

    params.task = 'kill';
    params.target = '/kill-' + vm_uuid;
    params.vm_uuid = vm_uuid;
    params.owner_uuid = req.vm.owner_uuid;
    params.server_uuid = req.vm.server_uuid;
    params['x-request-id'] = req.getId();

    setContext(req, params);

    if (req.params.creator_uuid !== undefined)
        params.creator_uuid = req.params.creator_uuid;
    if (req.params.origin !== undefined)
        params.origin = req.params.origin;

    self.client.createJob('kill', params, options, function (err, job) {
        if (err) {
            cb(err);
            return;
        }

        self.log.debug('Kill job ' + job.uuid + ' queued for VM ' +
            vm_uuid);
        cb(null, job.uuid);
    });
};



/*
 * Queues a reboot job.
 */
Wfapi.prototype.createRebootJob = function (req, cb) {
    var self = this;
    var vm_uuid = req.vm.uuid;
    var params = {};
    var options = { headers: { 'x-request-id': req.getId() } };

    params.task = 'reboot';
    params.target = '/reboot-' + vm_uuid;
    params.vm_uuid = vm_uuid;
    params.owner_uuid = req.vm.owner_uuid;
    params.server_uuid = req.vm.server_uuid;
    params.current_state = req.vm.state;
    params['x-request-id'] = req.getId();

    setContext(req, params);

    if (req.params.creator_uuid !== undefined)
        params.creator_uuid = req.params.creator_uuid;
    if (req.params.origin !== undefined)
        params.origin = req.params.origin;
    if (req.params.timeout !== undefined)
        params.timeout = req.params.timeout;
    if (req.params.update !== undefined)
        params.update = req.params.update;

    if (req.params['idempotent']) {
        params.idempotent = req.params['idempotent'];
    }

    self.client.createJob('reboot', params, options, function (err, job) {
        if (err) {
            cb(err);
            return;
        }

        self.log.debug('Reboot job ' + job.uuid + ' queued for VM ' + vm_uuid);
        cb(null, job.uuid);
    });
};



/*
 * Queues a reprovision job.
 */
Wfapi.prototype.createReprovisionJob = function (req, cb) {
    var self = this;
    var vm_uuid = req.vm.uuid;
    var params = { 'image_uuid': req.params['image_uuid'] };
    var options = { headers: { 'x-request-id': req.getId() } };

    params.task = 'reprovision';
    params.target = '/reprovision-' + vm_uuid;
    params.vm_uuid = vm_uuid;
    params.owner_uuid = req.vm.owner_uuid;
    params.server_uuid = req.vm.server_uuid;
    params['x-request-id'] = req.getId();

    setContext(req, params);

    if (req.params.creator_uuid !== undefined)
        params.creator_uuid = req.params.creator_uuid;
    if (req.params.origin !== undefined)
        params.origin = req.params.origin;

    self.client.createJob('reprovision', params, options, function (err, job) {
        if (err) {
            cb(err);
            return;
        }

        self.log.debug('Reprovision job ' + job.uuid + ' queued for VM ' +
            vm_uuid);
        cb(null, job.uuid);
    });
};



/*
 * Queues a destroy job.
 */
Wfapi.prototype.createDestroyJob = function (req, cb) {
    var self = this;
    var vm_uuid = req.vm.uuid;
    var params = {};
    var options = { headers: { 'x-request-id': req.getId() } };

    params.task = 'destroy';
    params.target = '/destroy-' + vm_uuid;
    params.vm_uuid = vm_uuid;
    params.owner_uuid = req.vm.owner_uuid;
    params.server_uuid = req.vm.server_uuid;
    params.current_state = req.vm.state;
    params.currentVm = req.vm;
    params['x-request-id'] = req.getId();

    setContext(req, params);

    if (req.params.creator_uuid !== undefined)
        params.creator_uuid = req.params.creator_uuid;
    if (req.params.origin !== undefined)
        params.origin = req.params.origin;

    self.client.createJob('destroy', params, options, function (err, job) {
        if (err) {
            cb(err);
            return;
        }

        self.log.debug('Destroy job ' + job.uuid + ' queued for VM ' + vm_uuid);
        cb(null, job.uuid);
    });
};



/*
 * Queues an update job.
 */
Wfapi.prototype.createUpdateJob = function (req, payload, cb) {
    var self = this;
    var vm_uuid = req.vm.uuid;
    var options = { headers: { 'x-request-id': req.getId() } };

    var subtask = payload.subtask;
    delete payload.subtask;
    delete payload['package'];

    var params = { payload: payload, subtask: subtask };

    params.task = 'update';
    params.target = '/update-' + vm_uuid;
    params.vm_uuid = vm_uuid;
    params.image_uuid = req.vm.image_uuid;
    params.vm_brand = req.vm.brand;
    params.owner_uuid = req.vm.owner_uuid;
    params.server_uuid = req.vm.server_uuid;
    params.last_modified = req.vm.last_modified;
    params['x-request-id'] = req.getId();

    setContext(req, params);

    if (req.params.creator_uuid !== undefined)
        params.creator_uuid = req.params.creator_uuid;
    if (req.params.origin !== undefined)
        params.origin = req.params.origin;

    if (params.subtask === 'resize') {
        params.current_ram = req.vm.ram || req.vm.max_physical_memory;
        params.current_quota = req.vm.quota;
        if (req.params.force === true || req.params.force === 'true') {
            params.force = true;
        }
    }

    self.client.createJob('update', params, options, function (err, job) {
        if (err) {
            cb(err);
            return;
        }

        self.log.debug('Update job ' + job.uuid + ' queued for VM ' + vm_uuid);
        cb(null, job.uuid);
    });
};



/*
 * Queues an add nics (update) job.
 *
 * params must be one of 'networks' or 'macs'. 'networks' must contain an array
 * of networks that will be used to create a new NIC in NAPI and on the VM.
 * 'mac' is the MAC address of an already-existing NIC in NAPI (but not on the
 * VM), which will be now created on the VM by the job.
 */
Wfapi.prototype.createAddNicsJob = function (req, params, cb) {
    var self = this;
    var vm_uuid = req.vm.uuid;
    var options = { headers: { 'x-request-id': req.getId() } };

    params.task = 'add_nics';
    params.target = '/add-nics-' + vm_uuid;
    params.vm_uuid = vm_uuid;
    params.owner_uuid = req.vm.owner_uuid;
    params.server_uuid = req.vm.server_uuid;
    params.last_modified = req.vm.last_modified;
    params.oldResolvers = req.vm.resolvers;
    params.wantResolvers = true;
    params['x-request-id'] = req.getId();

    setContext(req, params);

    if (req.params.creator_uuid !== undefined)
        params.creator_uuid = req.params.creator_uuid;
    if (req.params.origin !== undefined)
        params.origin = req.params.origin;

    // If internal_metadata.set_resolvers === false, we always want
    // to leave the resolvers as empty
    if (req.vm.internal_metadata !== undefined &&
        typeof (req.vm.internal_metadata) === 'object' &&
        req.vm.internal_metadata.set_resolvers === false) {
        params.wantResolvers = false;
    }

    self.client.createJob('add-nics', params, options, function (err, job) {
        if (err) {
            cb(err);
            return;
        }

        self.log.debug('Add NICs job ' + job.uuid + ' queued for VM '+
            vm_uuid);
        cb(null, job.uuid);
    });
};



/*
 * Queues an update nics (update) job.
 */
Wfapi.prototype.createUpdateNicsJob = function (req, nics, cb) {
    var self = this;
    var params = { 'update_nics': nics };
    var vm_uuid = req.vm.uuid;
    var options = { headers: { 'x-request-id': req.getId() } };

    params.task = 'update_nics';
    params.target = '/update-nics-' + vm_uuid;
    params.vm_uuid = vm_uuid;
    params.owner_uuid = req.vm.owner_uuid;
    params.server_uuid = req.vm.server_uuid;
    params.last_modified = req.vm.last_modified;
    params['x-request-id'] = req.getId();

    setContext(req, params);

    if (req.params.creator_uuid !== undefined)
        params.creator_uuid = req.params.creator_uuid;
    if (req.params.origin !== undefined)
        params.origin = req.params.origin;

    self.client.createJob('update-nics', params, options, function (err, job) {
        if (err) {
            cb(err);
            return;
        }

        self.log.debug('Update NICs job ' + job.uuid + ' queued for VM '+
            vm_uuid);
        cb(null, job.uuid);
    });
};



/*
 * Queues a remove nics (update) job.
 */
Wfapi.prototype.createRemoveNicsJob = function (req, macs, cb) {
    var self = this;
    var params = { remove_nics: macs };
    var vm_uuid = req.vm.uuid;
    var options = { headers: { 'x-request-id': req.getId() } };

    params.task = 'remove_nics';
    params.target = '/remove-nics-' + vm_uuid;
    params.vm_uuid = vm_uuid;
    params.owner_uuid = req.vm.owner_uuid;
    params.server_uuid = req.vm.server_uuid;
    params.last_modified = req.vm.last_modified;
    params.wantResolvers = true;
    params['x-request-id'] = req.getId();

    setContext(req, params);

    if (req.params.creator_uuid !== undefined)
        params.creator_uuid = req.params.creator_uuid;
    if (req.params.origin !== undefined)
        params.origin = req.params.origin;

    // If internal_metadata.set_resolvers === false, we always want
    // to leave the resolvers as empty
    if (req.vm.internal_metadata !== undefined &&
        typeof (req.vm.internal_metadata) === 'object' &&
        req.vm.internal_metadata.set_resolvers === false) {
        params.wantResolvers = false;
    }

    // Sent the MACs of the NICs in order
    params.oldMacs = [];
    for (var i = 0; i < req.vm.nics.length; i++) {
        params.oldMacs.push(req.vm.nics[i].mac);
    }

    self.client.createJob('remove-nics', params, options, function (err, job) {
        if (err) {
            cb(err);
            return;
        }

        self.log.debug('Remove NICs job ' + job.uuid + ' queued for VM '+
            vm_uuid);
        cb(null, job.uuid);
    });
};



/*
 * Generates a timestamp for the default snapshot name
 */
function formatTimestamp(now) {
    if (!now) {
        now = new Date();
    }

    return now.getFullYear() + '' +
        sprintf('%02d', now.getMonth() + 1) + '' +
        sprintf('%02d', now.getDate()) + 'T' +
        sprintf('%02d', now.getHours()) + '' +
        sprintf('%02d', now.getMinutes()) + '' +
        sprintf('%02d', now.getSeconds()) + 'Z';
}



/*
 * Queues a snapshot job.
 */
Wfapi.prototype.createSnapshotJob = function (req, cb) {
    var self = this;
    var vm_uuid = req.vm.uuid;
    var params = {
        'snapshot_name': req.params['snapshot_name'] || formatTimestamp()
    };
    var options = { headers: { 'x-request-id': req.getId() } };

    params.task = 'snapshot';
    params.target = '/snapshot-' + vm_uuid;
    params.vm_uuid = vm_uuid;
    params.owner_uuid = req.vm.owner_uuid;
    params.server_uuid = req.vm.server_uuid;
    params['x-request-id'] = req.getId();

    setContext(req, params);

    if (req.params.creator_uuid !== undefined)
        params.creator_uuid = req.params.creator_uuid;
    if (req.params.origin !== undefined)
        params.origin = req.params.origin;

    self.client.createJob('snapshot', params, options, function (err, job) {
        if (err) {
            cb(err);
            return;
        }

        self.log.debug('Snapshot job ' + job.uuid +
            ' queued for VM ' + vm_uuid);
        cb(null, job.uuid);
    });
};



/*
 * Queues a rollback job.
 */
Wfapi.prototype.createRollbackJob = function (req, cb) {
    var self = this;
    var vm_uuid = req.vm.uuid;
    var params = { 'snapshot_name': req.params['snapshot_name'] };
    var options = { headers: { 'x-request-id': req.getId() } };

    params.task = 'snapshot';
    params.target = '/rollback-' + vm_uuid;
    params.vm_uuid = vm_uuid;
    params.vm_state = req.vm.state;
    params.owner_uuid = req.vm.owner_uuid;
    params.server_uuid = req.vm.server_uuid;
    params['x-request-id'] = req.getId();

    setContext(req, params);

    if (req.params.creator_uuid !== undefined)
        params.creator_uuid = req.params.creator_uuid;
    if (req.params.origin !== undefined)
        params.origin = req.params.origin;

    self.client.createJob('rollback', params, options, function (err, job) {
        if (err) {
            cb(err);
            return;
        }

        self.log.debug('Rollback job ' + job.uuid +
            ' queued for VM ' + vm_uuid);
        cb(null, job.uuid);
    });
};



/*
 * Queues a delete snapshot job.
 */
Wfapi.prototype.createDeleteSnapshotJob = function (req, cb) {
    var self = this;
    var vm_uuid = req.vm.uuid;
    var params = { 'snapshot_name': req.params['snapshot_name'] };
    var options = { headers: { 'x-request-id': req.getId() } };

    params.task = 'snapshot';
    params.target = '/delete-snapshot-' + vm_uuid;
    params.vm_uuid = vm_uuid;
    params.vm_state = req.vm.state;
    params.owner_uuid = req.vm.owner_uuid;
    params.server_uuid = req.vm.server_uuid;
    params['x-request-id'] = req.getId();

    setContext(req, params);

    if (req.params.creator_uuid !== undefined)
        params.creator_uuid = req.params.creator_uuid;
    if (req.params.origin !== undefined)
        params.origin = req.params.origin;

    self.client.createJob('delete-snapshot', params, options,
      function (err, job) {
        if (err) {
            cb(err);
            return;
        }

        self.log.debug('Delete snapshot job ' + job.uuid +
            ' queued for VM ' + vm_uuid);
        cb(null, job.uuid);
    });
};



/*
 * Retrieves a job from WFAPI.
 */
Wfapi.prototype.getJob = function (jobUuid, cb) {
    this.client.getJob(jobUuid, function (err, job) {
        if (err) {
            cb(err);
            return;
        }

        cb(null, common.translateJob(job));
    });
};



/*
 * Lists jobs from WFAPI.
 */
Wfapi.prototype.listJobs = function (params, cb) {
    var query = {};

    if (params.execution) {
        query.execution = params.execution;
    }

    if (params.task) {
        query.task = params.task;
    }

    if (params.vm_uuid) {
        query.vm_uuid = params.vm_uuid;
    }

    this.client.listJobs(query, function (err, jobs) {
        if (err) {
            cb(err);
            return;
        }

        var theJobs = [];
        for (var i = 0; i < jobs.length; i++) {
            theJobs.push(common.translateJob(jobs[i]));
        }

        cb(null, theJobs);
    });
};



/*
 * Take any x-context header from the caller and put it in the params fed
 * to further API calls. NB: params arg is mutated.
 */
function setContext(req, params) {
    var context = req.headers['x-context'];

    if (context) {
        try {
            params.context = JSON.parse(context);
        } catch (e) {
            // Moooving forward, no big deal
        }
    }
}



module.exports = Wfapi;
