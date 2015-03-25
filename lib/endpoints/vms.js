/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * A brief overview of this source file: what is its purpose.
 */

var assert = require('assert');
var restify = require('restify');
var async = require('async');

var common = require('../common');
var util = require('../common/util');
var errors = require('../errors');

var VALID_VM_ACTIONS = [
    'start',
    'stop',
    'kill',
    'reboot',
    'reprovision',
    'update',
    'add_nics',
    'update_nics',
    'remove_nics',
    'create_snapshot',
    'rollback_snapshot',
    'delete_snapshot'
];


function validAction(action) {
    return VALID_VM_ACTIONS.indexOf(action) != -1;
}


function renderVms(req, res, next) {
    req.log.trace('RenderVms start');

    if (!req.query.fields) {
        res.send(200, req.vms || req.vm);
        return next();
    }

    var moray = req.app.moray;

    // For each async field a function is called and the expected callback
    // is in the form of cb(err, obj) so we can do vm[field] = obj;
    // This is not needd for role_tags only but it's added in case new async
    // fields are added to VM objects
    var asyncFields = {
        role_tags: moray.getVmRoleTags.bind(moray)
    };
    var fieldsParam = req.query.fields.split(',');
    var fields = [];

    // Take any vm to get all its default rendered fields
    var aVm = (req.vms ? req.vms[0] : req.vm);
    var vmFields = Object.keys(aVm);

    // See if '*' was passed and remove duplicates
    for (var i = 0; i < fieldsParam.length; i++) {
        if (fieldsParam[i] === '*') {
            fields = vmFields;
            fields = fields.concat(Object.keys(asyncFields));
            break;
        } else {
            fields.push(fieldsParam[i]);
        }
    }

    fields = fields.filter(function (elem, index) {
        return (index == fields.indexOf(elem));
    });

    // This function is used to return a response from either GetVm or ListVms
    function respond(err, object) {
        if (err) {
            return next(err);
        }
        res.send(200, object);
        return next();
    }

    if (!req.vms) {
        return renderSingleVm(req.vm, respond);
    }

    // Expensive operation: if async fields are requested there is a moray
    // request per VM. This is done serially because we can't mess up the
    // original ordering returned by moray
    var vms = [];
    async.eachSeries(req.vms, function (vm, cb) {
        renderSingleVm(vm, function (err, newVm) {
            if (err) {
                return cb(err);
            }
            vms.push(newVm);
            return cb();
        });
    }, function (err) {
        respond(err, vms);
    });

    function renderSingleVm(fullVm, nextVm) {
        var vm = {};
        var uuid = fullVm.uuid;

        async.each(fields, function (field, cb) {
            if (asyncFields[field]) {
                asyncFields[field].call(moray, uuid, function (err, obj) {
                    if (err) {
                        return cb(err);
                    }

                    vm[field] = obj;
                    return cb();
                });
            } else {
                vm[field] = fullVm[field];
                return cb();
            }
        }, function (err) {
            if (err) {
                return nextVm(err);
            }
            return nextVm(null, vm);
        });
    }
}



function preFilterVms(req, res, next) {
    req.log.trace('PreFilterVms start');
    var error, message;

    if (!req.query.role_tags) {
        return next();
    }

    var roleTags = req.query.role_tags.split(',');

    roleTags.forEach(function (roleTag) {
        if (!common.validUUID(roleTag)) {
            message = roleTag + ' is not a UUID';
            error = [ errors.invalidUuidErr('role_tags', message) ];
            return next(new errors.ValidationFailedError(
                        'Invalid Role Tags', error));
        }
    });

    req.app.moray.getRoleTags(roleTags, function (err, uuids) {
        if (err) {
            return next(err);
        }

        if (!uuids.length) {
            res.header('x-joyent-resource-count', 0);
            res.send(200, []);
            return next(false);
        }

        req.uuids = uuids;
        return next();
    });
}



/*
 * GET /vms
 *
 * Returns a list of vms according the specified search filter. The valid
 * query options are: owner_uuid, brand, alias, status, and ram.
 */
function listVms(req, res, next) {
    req.log.trace('ListVms start');

    var params = common.clone(req.params);
    if (req.uuids) {
        params.uuids = req.uuids;
    } else if (params.uuids && typeof (params.uuids) === 'string') {
        params.uuids = params.uuids.split(',');
    }

    return req.app.moray.countVms(params, function (error, count) {
        if (error) {
            return next(error);
        }

        res.header('x-joyent-resource-count', count);
        return req.app.moray.listVms(params, function (err, vms) {
            if (err) {
                return next(err);
            }

            // curl is retarded
            /* BEGIN JSSTYLED */
            if (req.headers['user-agent'] &&
                /^curl.*/.test(req.headers['user-agent'])) {
                    res.set('Connection', 'close');
            }
            /* END JSSTYLED */

            if (req.method == 'HEAD') {
                res.send(200);
            } else {
                req.vms = vms;
            }

            return next();
        });
    });
}


/*
 * GET /vms/:uuid/proc
 */
function getVmProc(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid }, 'GetVmProc start');
    var error;
    var m = req.vm;

    // Skip calling CNAPI when a VM hasn't been allocated to a server
    if (m.server_uuid === undefined) {
        error = [ errors.invalidUuidErr('vm.server_uuid') ];
        return next(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    return req.app.cnapi.getVmProc(m.server_uuid, m.uuid, function (err, proc) {
        if (!err) {
            res.send(200, proc);
        }
        return next(err);
    });
}


/*
 * GET /vms/:uuid
 */
function getVm(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid }, 'GetVm start');
    var m = req.vm;

    // if (m.server_uuid && req.params.sync && req.params.sync == 'true') {
    if (req.params.sync && req.params.sync == 'true') {
        // Skip calling CNAPI when a VM hasn't been allocated to a server
        if (m.server_uuid !== undefined) {
            return req.app.cnapi.getVm(m.server_uuid, m.uuid, true, onGetVm);
        } else {
            return onGetVm(null, null);
        }

    } else {
        return next();
    }

    // When ?sync=true first call CNAPI
    function onGetVm(err, vm) {
        if (err) {
            return next(err);
        }

        if (vm) {
            var newVm = common.translateVm(vm, true);
            req.app.moray.putVm(newVm.uuid, newVm, function (putErr) {
                if (putErr) {
                    req.log.error({ err: putErr, uuid: newVm.uuid },
                        'Error storing VM on moray (force cache refresh)');
                    return next(putErr);

                } else {
                    req.log.debug('VM object %s updated on moray (refresh)',
                        newVm.uuid);
                    return refreshCache(newVm);
                }
            });

        } else {
            markAsDestroyed(req, function (markErr, modVm) {
                if (markErr) {
                    return next(markErr);
                }

                // Allow the heartbeater to clear any marked errors
                delete req.app.heartbeater.errorVms[modVm.uuid];

                req.vm = modVm;
                return next();
            });
        }
    }

    function refreshCache(vm) {
        req.app.cache.setState(vm.uuid, vm, vm.server_uuid, function (err) {
            if (err) {
                req.log.error(err, 'Error refreshing VM cached state');
            }

            // Allow the heartbeater to clear any marked errors
            delete req.app.heartbeater.errorVms[vm.uuid];

            req.vm = vm;
            return next();
        });
    }
}

/**
 * Send a response for an UpdateVm action, waiting for workflow depending on
 * whether the sync parameter is specified.
 */

function handleUpdateVMResponse(req, res, next, juuid) {
    // Allow clients to know the location of WFAPI
    res.header('workflow-api', req.app.config.wfapi.url);

    var sync = req.params.sync;
    if (sync) {
        /*
         * Node's default HTTP timeout is two minutes, and sync requests can
         * take longer than that to complete. Set this connection's
         * timeout to an hour to avoid an abrupt close after two minutes.
         */
        req.connection.setTimeout(60 * 60 * 1000);

        var opts = {
            log: req.log,
            job_uuid: juuid,
            wfapi: req.app.wfapi
        };
        util.waitForJob(opts, function (error) {
            if (error) {
                return next(error);
            }
            res.send(202, { vm_uuid: req.vm.uuid, job_uuid: juuid });
            return next();
        });
    } else {
        res.send(202, { vm_uuid: req.vm.uuid, job_uuid: juuid });
        return next();
    }
}



/*
 * POST /vms/:uuid
 */
function updateVm(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid }, 'UpdateVm start');
    var method;
    var action = req.params.action;
    var sync = req.params.sync;
    var error;

    if (!action) {
        error = [ errors.missingParamErr('action') ];
        return next(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    if (!validAction(action)) {
        error = [ errors.invalidParamErr('action') ];
        return next(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    if (sync && ['true', 'false'].indexOf(sync) === -1) {
        error = [ errors.invalidParamErr('sync') ];
        return next(new errors.ValidationFailedError('Invalid Parameters',
            error));
    } else {
        req.params.sync = (sync === 'true' ? true : false);
    }

    switch (action) {
        case 'start':
            method = startVm;
            break;
        case 'stop':
            method = stopVm;
            break;
        case 'kill':
            method = killVm;
            break;
        case 'reboot':
            method = rebootVm;
            break;
        case 'update':
            method = changeVm;
            break;
        case 'reprovision':
            method = reprovisionVm;
            break;
        case 'add_nics':
            method = addNics;
            break;
        case 'update_nics':
            method = updateNics;
            break;
        case 'remove_nics':
            method = removeNics;
            break;
        case 'create_snapshot':
            method = createSnapshot;
            break;
        case 'rollback_snapshot':
            method = rollbackSnapshot;
            break;
        case 'delete_snapshot':
            method = deleteSnapshot;
            break;
        default:
            error = [ errors.invalidParamErr('action') ];
            return next(new errors.ValidationFailedError('Invalid Parameters',
                error));
    }

    if (req.vm.state === 'provisioning') {
        return next(new errors.UnallocatedVMError(
            'Cannot call ' + action +
            ' for a VM that has not been provisioned yet'));
    }

    return method.call(this, req, res, next);
}



/*
 * Starts a vm with ?action=start
 */
function startVm(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid }, 'StartVm start');

    req.app.wfapi.createStartJob(req, function (err, juuid) {
        if (err) {
            return next(err);
        }

        return handleUpdateVMResponse(req, res, next, juuid);
    });
}



/*
 * Stops a vm with ?action=stop
 */
function stopVm(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid }, 'StopVm start');

    req.app.wfapi.createStopJob(req, function (err, juuid) {
        if (err) {
            return next(err);
        }

        return handleUpdateVMResponse(req, res, next, juuid);
    });
}



/*
 * Sends a signal to a vm with ?action=kill
 */
function killVm(req, res, next) {

    // XXX This includes all signals from process.binding('constants') plus
    // the special '0' signal. Anything not on this list is not supported by
    // the backend, but it's possible we'll want to remove some from this list
    // too as some of these probably don't make sense to send.
    var valid_signals = [
        'SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGCHLD', 'SIGCONT', 'SIGFPE',
        'SIGHUP', 'SIGILL', 'SIGINT', 'SIGIO', 'SIGIOT', 'SIGKILL', 'SIGLOST',
        'SIGPIPE', 'SIGPOLL', 'SIGPROF', 'SIGPWR', 'SIGQUIT', 'SIGSEGV',
        'SIGSTOP', 'SIGSYS', 'SIGTERM', 'SIGTRAP', 'SIGTSTP', 'SIGTTIN',
        'SIGTTOU', 'SIGURG', 'SIGUSR1', 'SIGUSR2', 'SIGVTALRM', 'SIGWINCH',
        'SIGXCPU', 'SIGXFSZ', 'ABRT', 'ALRM', 'BUS', 'CHLD', 'CONT', 'FPE',
        'HUP', 'ILL', 'INT', 'IO', 'IOT', 'KILL', 'LOST', 'PIPE', 'POLL',
        'PROF', 'PWR', 'QUIT', 'SEGV', 'STOP', 'SYS', 'TERM', 'TRAP', 'TSTP',
        'TTIN', 'TTOU', 'URG', 'USR1', 'USR2', 'VTALRM', 'WINCH', 'XCPU',
        'XFSZ', 0, 1, 2, 3, 4, 5, 6, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
        18, 19, 20, 21, 22, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 37
    ];

    req.log.trace({ vm_uuid: req.params.uuid }, 'KillVm start');

    if (req.params.signal) {
        if (valid_signals.indexOf(req.params.signal) === -1) {
            var error = [ errors.invalidParamErr('signal') ];
            return next(new errors.ValidationFailedError('Invalid Parameters',
                error));
        }
    }

    req.app.wfapi.createKillJob(req, function (err, juuid) {
        if (err) {
            return next(err);
        }

        return handleUpdateVMResponse(req, res, next, juuid);
    });
}



/*
 * Reboots a vm with ?action=reboot
 */
function rebootVm(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid }, 'RebootVm start');

    req.app.wfapi.createRebootJob(req, function (err, juuid) {
        if (err) {
            return next(err);
        }

        return handleUpdateVMResponse(req, res, next, juuid);
    });
}



/*
 * Re-provisions a vm with ?action=reprovision
 */
function reprovisionVm(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid }, 'ReprovisionVm start');
    var vm = req.vm;

    if (vm.brand !== 'joyent' && vm.brand !== 'joyent-minimal') {
        return next(new errors.BrandNotSupportedError(
            'VM \'brand\' does not support reprovision'));
    }

    if (!req.params.image_uuid) {
        var error = [ errors.missingParamErr('image_uuid') ];
        return next(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    req.app.wfapi.createReprovisionJob(req, function (err, juuid) {
        if (err) {
            return next(err);
        }

        return handleUpdateVMResponse(req, res, next, juuid);
    });
}



/*
 * Changes a vm with ?action=update
 */
function changeVm(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid }, 'ChangeVm start');
    req.log.debug({ params: req.params }, 'changeVm req.params');

    common.validateUpdateVmParams(req.app, req.vm, req.params, onValidate);

    function onValidate(verr, params) {
        if (verr) {
            next(verr);
            return;
        }

        req.log.debug({ params: params }, 'changeVm validated params');
        req.app.wfapi.createUpdateJob(req, params, function (err, juuid) {
            if (err) {
                return next(err);
            }

            return handleUpdateVMResponse(req, res, next, juuid);
        });
    }
}



/*
 * Adds NICs to a VM
 */
function addNics(req, res, next) {
    var params = req.params;
    req.log.trace({ vm_uuid: params.uuid }, 'AddNics start');

    var creationArgs;

    // we must receive either networks or mac as param
    if (params.networks) {
        try {
            common.validateNetworks(params);
        } catch (err) {
            return next(err);
        }

        creationArgs = { networks: params.networks };
    } else {
        try {
            common.validateMacs(params);
        } catch (err) {
            return next(err);
        }

        creationArgs = { macs: params.macs };
    }

    req.app.wfapi.createAddNicsJob(req, creationArgs, onAddNicsJob);

    function onAddNicsJob(err, juuid) {
        if (err) {
            return next(err);
        }

        return handleUpdateVMResponse(req, res, next, juuid);
    }
}



/*
 * Updates NICs on a VM
 */
function updateNics(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid }, 'UpdateNics start');

    try {
        common.validateNics(req.vm, req.params);
        req.app.wfapi.createUpdateNicsJob(req, req.params.nics, onUpdateJob);
    } catch (err) {
        return next(err);
    }

    function onUpdateJob(err, juuid) {
        if (err) {
            return next(err);
        }

        return handleUpdateVMResponse(req, res, next, juuid);
    }
}



/*
 * Removes NICs from a VM
 */
function removeNics(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid }, 'RemoveNics start');

    try {
        common.validateMacs(req.params);
        req.app.wfapi.createRemoveNicsJob(req, req.params.macs, onRemoveNics);
    } catch (err) {
        return next(err);
    }

    function onRemoveNics(err, juuid) {
        if (err) {
            return next(err);
        }

        return handleUpdateVMResponse(req, res, next, juuid);
    }
}



/*
 * Helper function for marking a vm as destroyed
 */
function markAsDestroyed(req, cb) {
    if (req.params.sync && req.params.sync == 'true') {
        req.app.napi.deleteNics(req.vm, onNapiDeleted);
        req.app.moray.markAsDestroyed(req.vm, onCacheMark);
    }

    function onCacheMark(err, vm) {
        if (err) {
            req.log.error(err, 'Error marking %s as destroyed', vm.uuid);
            return cb(err);
        }

        req.log.info('VM %s marked as destroyed', vm.uuid);
        req.app.cache.delState(vm.uuid, function (cacheErr) {
            if (cacheErr) {
                req.log.error('Could not remove VM %s state from cache',
                    vm.uuid);
            }
            return cb(null, vm);
        });
    }

    function onNapiDeleted(err) {
        if (err) {
            req.log.error(err, 'Error deleting NICs for VM %s', req.vm.uuid);
        } else {
            req.log.info('NICs for VM %s deleted from NAPI', req.vm.uuid);
        }
    }
}


/*
 * Deletes a vm
 */
function deleteVm(req, res, next) {
    var sync = req.params.sync;

    req.log.trace({ vm_uuid: req.params.uuid }, 'DeleteVm start');

    if (sync && ['true', 'false'].indexOf(sync) === -1) {
        var error = [ errors.invalidParamErr('sync') ];
        return next(new errors.ValidationFailedError('Invalid Parameters',
            error));
    } else {
        req.params.sync = (sync === 'true' ? true : false);
    }

    return req.app.wfapi.createDestroyJob(req, function (err, juuid) {
        if (err) {
            return next(err);
        }

        return handleUpdateVMResponse(req, res, next, juuid);
    });
}



/*
 * Optional when role_tags are passed to the provision request
 */
function createRoleTags(req, cb) {
    var error, message;
    var roleTags = req.params.role_tags;

    if (!Array.isArray(roleTags) || Object.keys(roleTags).length === 0) {
        message = 'Must be an array of UUIDs';
        error = [ errors.invalidParamErr('role_tags', message) ];
        return cb(new errors.ValidationFailedError(
                    'Invalid VM parameters', error));
    }

    roleTags.forEach(function (roleTag) {
        if (!common.validUUID(roleTag)) {
            message = roleTag + ' is not a UUID';
            error = [ errors.invalidUuidErr('role_tags', message) ];
            return cb(new errors.ValidationFailedError(
                        'Invalid VM parameters', error));
        }
    });

    req.app.moray.putVmRoleTags(req.params.uuid, roleTags, cb);
}



/*
 * Creates a new vm. This endpoint returns a task id that can be used to
 * keep track of the vm provision
 */
function createVm(req, res, next) {
    req.log.trace('CreateVm start');

    var sync = req.params.sync;

    common.validateCreateVmParams(req.app, req.params, function (err) {
        if (err) {
            return next(err);
        }

        common.setDefaultValues(req.params, {config: req._config});

        if (sync && ['true', 'false'].indexOf(sync) === -1) {
            var error = [ errors.invalidParamErr('sync') ];
            return next(new errors.ValidationFailedError('Invalid Parameters',
                error));
        } else {
            req.params.sync = (sync === 'true' ? true : false);
        }

        createProvisionJob();
    });

    function createProvisionJob() {
        if (req.params.role_tags === undefined) {
            req.app.wfapi.createProvisionJob(req, onProvisionJob);
        } else {
            createRoleTags(req, function (err) {
                if (err) {
                    return next(err);
                }
                req.app.wfapi.createProvisionJob(req, onProvisionJob);
            });
        }
    }

    function rollbackRoleTags(err) {
        if (req.params.role_tags === undefined) {
            return next(err);
        }

        req.app.moray.delVmRoleTags(req.params.uuid, function (morayErr) {
            // If there is yet another error here we use the original error
            // from wfapi
            if (morayErr) {
                req.log.error({ err: morayErr, vm_uuid: req.params.uuid },
                    'Error deleting role_tags for VM %s', req.params.uuid);
            }
            return next(err);
        });
    }

    function onProvisionJob(err, vmuuid, juuid) {
        if (err) {
            return rollbackRoleTags(err);
        }

        req.params.state = 'provisioning';

        // Write the provisioning VM to moray
        var vm = common.translateVm(req.params, false);
        req.app.moray.putVm(vmuuid, vm, function (err2) {
            if (err2) {
                // When provision has been queued and moray fails putobject
                // we should be able to see the VM show up eventually when
                // its heartbeats are propagated
                req.log.error({ err: err2, vm_uuid: vmuuid },
                    'Error storing provisioning VM %s on moray', vmuuid);
            } else {
                req.log.debug({ vm_uuid: vmuuid },
                    'Provisioning VM %s added to moray', vmuuid);
            }


            req.vm = { uuid: vmuuid };
            return handleUpdateVMResponse(req, res, next, juuid);
        });
    }
}



/*
 * Snapshots a VM
 */
function createSnapshot(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid }, 'CreateSnapshot start');
    var vm = req.vm;

    if ((['joyent', 'joyent-minimal', 'sngl'].indexOf(vm.brand) === -1) ||
        (vm.datasets && vm.datasets.length && vm.datasets.length > 0)) {
        return next(new errors.BrandNotSupportedError(
            'snapshots are not supported for VMs with delegated datasets'));
    }

    req.app.wfapi.createSnapshotJob(req, function (err, juuid) {
        if (err) {
            return next(err);
        }

        return handleUpdateVMResponse(req, res, next, juuid);
    });
}



/*
 * Rollbacks a VM
 */
function rollbackSnapshot(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid }, 'RollbackSnapshot start');
    var vm = req.vm;

    if ((vm.brand !== 'joyent' && vm.brand !== 'joyent-minimal') ||
        (vm.datasets && vm.datasets.length && vm.datasets.length > 0)) {
        return next(new errors.BrandNotSupportedError(
            'VM \'brand\' does not support snapshots'));
    }

    if (!req.params.snapshot_name) {
        var error = [ errors.missingParamErr('snapshot_name') ];
        return next(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    return req.app.wfapi.createRollbackJob(req, function (err, juuid) {
        if (err) {
            return next(err);
        }

        return handleUpdateVMResponse(req, res, next, juuid);
    });
}



/*
 * Deletes a VM snapshot
 */
function deleteSnapshot(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid }, 'DeleteSnapshot start');
    var vm = req.vm;

    if ((vm.brand !== 'joyent' && vm.brand !== 'joyent-minimal') ||
        (vm.datasets && vm.datasets.length && vm.datasets.length > 0)) {
        return next(new errors.BrandNotSupportedError(
            'VM \'brand\' does not support snapshots'));
    }

    if (!req.params.snapshot_name) {
        var error = [ errors.missingParamErr('snapshot_name') ];
        return next(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    return req.app.wfapi.createDeleteSnapshotJob(req, function (err, juuid) {
        if (err) {
            return next(err);
        }

        return handleUpdateVMResponse(req, res, next, juuid);
    });
}



/*
 * Replaces all VMs for a server
 */
function putVms(req, res, next) {
    req.log.trace('PutVms start');
    var error;

    // if (req.app.useVmAgent !== true) {
    //     req.log.info('PutVms called and vm-agent feature is not active');
    //     res.send(200);
    //     return next(false);
    // }

    if (!req.query.server_uuid) {
        error = [ errors.missingParamErr('server_uuid') ];
        return next(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    if (!common.validUUID(req.query.server_uuid)) {
        error = [ errors.invalidUuidErr('server_uuid') ];
        return next(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    if (!req.params.vms) {
        error = [ errors.missingParamErr('vms') ];
        return next(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    async.eachSeries(Object.keys(req.params.vms), function (uuid, cb) {
        req.app.moray.putVm(uuid, req.params.vms[uuid], cb);
    }, function (err) {
        if (err) {
            return next(err);
        }

        res.send(200);
        return next();
    });
}



/*
 * Replaces a VM
 */
function putVm(req, res, next) {
    var log = req.log;
    log.trace('PutVm start');

    // if (req.app.useVmAgent !== true) {
    //     log.info('PutVm called and vm-agent feature is not active');
    //     res.send(200);
    //     return next();
    // }

    if (!common.validUUID(req.params.uuid)) {
        var error = [ errors.invalidUuidErr('uuid') ];
        return next(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    // Parse whatever is needed before putting a raw object from vm-agent
    var vm = common.translateVm(req.params, false);

    if (vm.state === 'destroyed') {
        // For now, cleanup VM nics as well until net-agent takes care of this
        req.app.moray.markAsDestroyed(vm, function (err) {
            if (err) {
                return next(err);
            }

            if (!vm.nics) {
                res.send(200, vm);
                return next();
            }

            // Don't return an error when deleteNics fails because this task
            // will be handled by net-agent soon
            req.app.napi.deleteNics(vm, function (napiErr) {
                if (napiErr) {
                    log.error(napiErr, 'Error deleting NICs for %', vm.uuid);
                }
                res.send(200, vm);
                return next();
            });
        });
    } else {
        req.app.moray.putVm(req.params.uuid, vm, function (err) {
            if (err) {
                return next(err);
            }

            res.send(200, vm);
            return next();
        });
    }
}



/*
 * Mounts vm actions as server routes
 */
function mount(server, before) {
    server.get({ path: '/vms', name: 'ListVms' },
                 before, preFilterVms, listVms, renderVms);

    server.head({ path: '/vms', name: 'HeadVms' },
                 before, preFilterVms, listVms);

    server.post({ path: '/vms', name: 'CreateVm' },
                  before, createVm);

    server.put({ path: '/vms', name: 'PutVms' },
                  before, putVms);

    server.get({ path: '/vms/:uuid/proc', name: 'GetVmProc' },
                 before, getVmProc);

    server.get({ path: '/vms/:uuid', name: 'GetVm' },
                 before, getVm, renderVms);

    server.head({ path: '/vms/:uuid', name: 'HeadVm' },
                 before, getVm, renderVms);

    server.del({ path: '/vms/:uuid', name: 'DeleteVm' },
                 before, deleteVm);

    server.post({ path: '/vms/:uuid', name: 'UpdateVm' },
                  before, updateVm);

    server.put({ path: '/vms/:uuid', name: 'PutVm' },
                  before, putVm);
}


// --- Exports

module.exports = {
    mount: mount
};
