/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * This contains the /vms endpoint handlers.
 */

var util = require('util');

var async = require('async');
var vasync = require('vasync');
var assert = require('assert-plus');
var deepDiff = require('deep-diff');
var restify = require('restify');

var common = require('../common');
var errors = require('../errors');
var interceptors = require('../interceptors');

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


var DEFAULT_LIST_VM_LIMIT = common.MAX_LIST_VMS_LIMIT;
var DEFAULT_LIST_VM_OFFSET = 0;
var VM = 'vm';

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
    // If we have an empty vms array though, just use an empty list
    // (we won't have anything to iterate over anyway)
    var vmFields = (typeof (aVm) === 'object') ? Object.keys(aVm) : [];

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
 * Returns a list of vms according the specified search filter.
 */
function listVms(req, res, next) {
    req.log.trace('ListVms start');

    function validateParams(done) {
        req.log.trace({params: req.params}, 'validating request params');

        common.validateListVmsParams(req.params, function validationDone(err) {
            if (err) {
                req.log.error({err: err}, 'request params validation error');
                return done(new errors.ValidationFailedError(
                    'Invalid Parameters', err));
            } else {
                return done();
            }
        });
    }

    function list(done) {
        req.log.trace('listing vms');

        var params = common.clone(req.params);
        if (req.uuids) {
            params.uuids = req.uuids;
        } else if (params.uuids && typeof (params.uuids) === 'string') {
            params.uuids = params.uuids.split(',');
        }

        req.app.moray.countVms(params, function (error, count) {
            if (error) {
                return done(error);
            }

            res.header('x-joyent-resource-count', count);

            var limit = DEFAULT_LIST_VM_LIMIT;
            if (req.params.limit !== undefined) {
                assert.number(req.params.limit,
                    'req.params.limit must be a number');
                limit = req.params.limit;
            }

            params.limit = limit;

            assert.ok(params.limit >= 0 &&
                params.limit <= common.MAX_LIST_VMS_LIMIT,
                'params.limit must be >= 0 and <= ' +
                common.MAX_LIST_VMS_LIMIT);

            var offset = DEFAULT_LIST_VM_OFFSET;
            if (req.params.offset !== undefined)
                offset = req.params.offset;

            params.offset = offset;

            return req.app.moray.listVms(params, function (err, vms) {
                if (err) {
                    return done(err);
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

                return done();
            });
        });
    }

    async.series([validateParams, list], function allDone(err) {
        if (err)
            req.log.debug({err: err});
        return next(err);
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

    if (m.state !== 'running') {
        return next(new errors.VmNotRunningError());
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
    var existingVm = req.vm;

    if (req.params.sync && req.params.sync == 'true') {
        // Skip calling CNAPI when a VM hasn't been allocated to a server
        if (existingVm.server_uuid !== undefined) {
            return req.app.cnapi.getVm(existingVm.server_uuid, existingVm.uuid,
                true, onGetVm);
        } else {
            return onGetVm(null, null);
        }

    } else {
        return next();
    }

    // When ?sync=true first call CNAPI
    function onGetVm(err, newVm) {
        if (err) {
            return next(err);
        }

        // Since the transitive_state property is not persisted
        // to the zone itself via vmadm, the vm object sent by CNAPI
        // does not have this property, and we must add it to that
        // object before it's persisted to moray.
        _overrideTransitiveState(existingVm, newVm);

        if (newVm) {
            newVm = common.translateVm(newVm, true);

            req.app.moray.putVm(newVm.uuid, newVm, function (putErr) {
                if (putErr) {
                    req.log.error({ err: putErr, uuid: newVm.uuid },
                        'Error storing VM on moray');
                    return next(putErr);

                }
                req.log.debug('VM object %s updated in moray', newVm.uuid);
                return next();
            });

        } else {
            existingVm.zone_state = 'destroyed';
            req.app.moray.markAsDestroyed(existingVm,
                function (markErr, modVm) {
                    if (markErr) {
                        return next(markErr);
                    }

                    req.vm = modVm;
                    return next();
                });
        }
    }
}

function _overrideTransitiveState(existingVm, newVm) {
    assert.object(existingVm, 'existingVm must be an object');
    assert.optionalObject(newVm, 'newVm must be an optional object');

    if (existingVm.transitive_state === 'destroying') {
        if (!newVm || newVm.state === 'destroyed') {
            delete newVm.transitive_state;
        } else {
            newVm.transitive_state = existingVm.transitive_state;
        }
    }
}
/**
 * Send a response for an UpdateVm action, waiting for workflow depending on
 * whether the sync parameter is specified.
 */

function handleUpdateVMResponse(req, res, next, juuid, taskName) {
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
            wfapi: req.app.wfapi,
            taskName: taskName
        };
        common.waitForJob(opts, function (error) {
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
 * Returns true if the action 'action' with parameters params is valid
 * on a VM that is being destroyed, false otherwise.
 */
function destroyingVmUpdateValid(params, action) {
    assert.object(params, 'params must be an object');
    assert.string(action, 'action must be a string');

    var paramNames, allowedParamNames, disallowedParamNames;
    // When a VM has state === 'destroyed' and zone_state !==
    // 'destroyed', it means that it's being destroyed, or that a
    // previous destroy workflow failed. Any other action than setting
    // its state to 'destroyed' is forbidden, except for:
    //
    // * Setting its 'indestructible_zoneroot' property in case it was
    // set to true, and it needs to be set to false before deleting
    // the VM.
    //
    // * Setting its zone_state to 'destroyed' once the VM is actually
    // destroyed.
    if (action !== 'update') {
        return false;
    } else {
        allowedParamNames = [
            'sync',
            'uuid',
            'indestructible_zoneroot',
            'indestructible_delegated',
            'action',
            'zone_state',
            'state'
        ];

        paramNames = Object.keys(params);
        disallowedParamNames = paramNames.filter(function (paramName) {
            return allowedParamNames.indexOf(paramName) === -1;
         });

        if (disallowedParamNames.length > 0) {
            return false;
        }

        if (params.indestructible_zoneroot &&
            params.indestructible_zoneroot !== false) {
            return false;
        }
    }

    return true;
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
    var vmBeingDestroyed = req.vm.transitive_state === 'destroying';
    var vmAlreadyDestroyed = req.vm.state === 'destroyed' &&
        req.vm.zone_state === 'destroyed';
    var zoneStateChangeError, stateChangeError;

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

    zoneStateChangeError = validZoneStateChange(req.vm, req.params);
    if (zoneStateChangeError) {
        return next(zoneStateChangeError);
    }

    stateChangeError = validStateChange(req.vm, req.params);
    if (stateChangeError) {
        // Silently override the params' state to be the current VM's state
        // so that updates of other properties than state can happen from
        // clients who have a different view of the VM's state than VMAPI
        // (e.g vm-agent).
        req.params.state = req.vm.state;
    }

    if (vmBeingDestroyed && !destroyingVmUpdateValid(req.params, action)) {
        return next(new errors.VMBeingDestroyedError());
    }

    if (vmAlreadyDestroyed) {
        // This VM has been destroyed, any update action is invalid
        return next(new errors.ChangingDestroyedVMError());
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

    if (req.params.idempotent) {
        if (req.params.idempotent === true ||
            req.params.idempotent === 'true') {

            req.params.idempotent = true;
        } else {
            var error = [ errors.invalidParamErr('idempotent') ];
            return next(new errors.ValidationFailedError('Invalid Parameters',
                error));
        }
    }

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

    if (req.params.idempotent) {
        if (req.params.idempotent === true ||
            req.params.idempotent === 'true') {

            req.params.idempotent = true;
        } else {
            var error = [ errors.invalidParamErr('idempotent') ];
            return next(new errors.ValidationFailedError('Invalid Parameters',
                error));
        }
    }

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
    var error;

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
            error = [ errors.invalidParamErr('signal') ];
            return next(new errors.ValidationFailedError('Invalid Parameters',
                error));
        }
    }

    if (req.params.idempotent) {
        if (req.params.idempotent === true ||
            req.params.idempotent === 'true') {

            req.params.idempotent = true;
        } else {
            error = [ errors.invalidParamErr('idempotent') ];
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

    if (req.params.idempotent) {
        if (req.params.idempotent === true ||
            req.params.idempotent === 'true') {

            req.params.idempotent = true;
        } else {
            var error = [ errors.invalidParamErr('idempotent') ];
            return next(new errors.ValidationFailedError('Invalid Parameters',
                error));
        }
    }

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

    if (['joyent', 'joyent-minimal', 'lx'].indexOf(vm.brand) === -1) {
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
 * Deletes a vm
 */
function deleteVm(req, res, next) {
    assert.object(req.vm, 'req.vm must be an object');

    var sync = req.params.sync;

    req.log.trace({ vm_uuid: req.params.uuid }, 'DeleteVm start');

    if (req.vm.state === 'provisioning') {
        return next(new restify.errors.ConflictError('Cannot delete a VM ' +
            'when it is provisioning'));
    }

    if (sync && ['true', 'false'].indexOf(sync) === -1) {
        var error = [ errors.invalidParamErr('sync') ];
        return next(new errors.ValidationFailedError('Invalid Parameters',
            error));
    } else {
        req.params.sync = (sync === 'true' ? true : false);
    }

    // If the vm has no server_uuid and unless it's provisioning, then starting
    // a destroy workflow would fail right after it starts, since there's
    // nothing to delete on any CN. In this case, instead of taking some space
    // in the workflow's queue (slowing down any other worfklow) and waiting
    // for the workflow to fail, just mark the VM as destroyed in moray.
    // It's faster, and uses far less resources of the overall system.
    if (req.vm.server_uuid === undefined || req.vm.server_uuid === null) {
        _destroyVm(req.vm, {
            publisher: req.app.publisher,
            moray: req.app.moray
        }, function (err, destroyedVm) {
            if (err) {
                return next(err);
            }

            res.send(200, destroyedVm);
            return next();
        });
    } else {
        req.app.cnapi.getServer(req.vm.server_uuid,
            function onGetServer(err, server) {
                var serverNotFoundError = _cnapiServerNotFoundError(err);
                if (err && !serverNotFoundError) {
                    return next(err);
                }

                if (serverNotFoundError) {
                    _destroyVm(req.vm, {
                        publisher: req.app.publisher,
                        moray: req.app.moray
                    }, function (destroyErr, destroyedVm) {
                        if (destroyErr) {
                            return next(err);
                        }

                        res.send(200, destroyedVm);
                        return next();
                    });
                } else {
                    return req.app.wfapi.createDestroyJob(req,
                        function (jobErr, juuid) {
                            if (jobErr) {
                                return next(jobErr);
                            }

                            // If sync===true, do not wait until the VM has
                            // actually been destroyed and the whole workflow
                            // has completed. Only wait until the VM has
                            // stopped (the 'cnapi.wait_stop_vm_task' task is
                            // finished).
                            return handleUpdateVMResponse(req, res, next,
                                juuid, 'cnapi.wait_stop_vm_task');
                        });
                }
            });
    }
}

function _cnapiServerNotFoundError(err) {
    return err && err.body && err.body.code === 'ResourceNotFound';
}

function _destroyVm(vm, options, cb) {
    assert.object(vm, 'vm must be an object');
    assert.object(options, 'options must be an object');
    assert.object(options.publisher, 'publisher must be an object');
    assert.object(options.moray, 'moray must be an object');
    assert.func(cb, 'cb must be a function');

    vasync.waterfall([
        function markVmAsDestroyed(next) {
            options.moray.markAsDestroyed(vm, next);
        },
        function publishVmChange(destroyedVm, next) {
            common.publishChange(options.publisher, VM,
                [destroyedVm.state], destroyedVm.uuid,
                function onChangePublished(err) {
                    next(err, destroyedVm);
                    return;
                });
        }
    ], function vmDestroyed(err, destroyedVm) {
        cb(err, destroyedVm);
        return;
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

        // Set timestamp to now so that VMs being provisioned will have a create
        // timestamp of when we started the provision.
        req.params.create_timestamp = (new Date());

        // Write the provisioning VM to moray
        var vm = common.translateVm(req.params, false);
        req.app.moray.putVm(vmuuid, vm, function (err2) {
            if (err2) {
                // When provision has been queued and moray fails putobject
                // we should be able to see the VM show up eventually when
                // vm-agent sees it.
                req.log.error({ err: err2, vm_uuid: vmuuid },
                    'Error storing provisioning VM %s in moray', vmuuid);
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
 * Returns either true or an error indicating why snapshots are not supported
 * for this VM.
 */
function canSnapshot(vm) {

    if (['joyent', 'joyent-minimal', 'sngl', 'lx'].indexOf(vm.brand) === -1) {
        return (new errors.BrandNotSupportedError(
            'snapshots are not supported for VMs of brand "' + vm.brand + '"'));
    }

    if (vm.datasets && vm.datasets.length && vm.datasets.length > 0) {
        return (new errors.BrandNotSupportedError(
            'snapshots are not supported for VMs with delegated datasets'));
    }

    /*
     * When docker volumes use --volumes-from, we need to make it very clear
     * that a snapshot of the container will not include data from the other
     * container that actually has the data, until then it's safer to just deny
     * snapshots for any VMs with --volumes-from.
     */
    if (vm.docker &&
        vm.internal_metadata.hasOwnProperty('docker:volumesfrom')) {

        return (new errors.BrandNotSupportedError('snapshots are not '
            + 'supported for docker VMs that use --volumes-from'));
    }

    return true;
}


/*
 * Snapshots a VM
 */
function createSnapshot(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid }, 'CreateSnapshot start');
    var canSnap;
    var vm = req.vm;

    canSnap = canSnapshot(vm);
    if (util.isError(canSnap)) {
        // can't snapshot, canSnap is an error telling us why
        return next(canSnap);
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
    var canSnap;
    var vm = req.vm;

    canSnap = canSnapshot(vm);
    if (util.isError(canSnap)) {
        // can't snapshot, canSnap is an error telling us why
        return next(canSnap);
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
    var canSnap;
    var vm = req.vm;

    canSnap = canSnapshot(vm);
    if (util.isError(canSnap)) {
        // can't snapshot, canSnap is an error telling us why
        return next(canSnap);
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

    // TODO: It is broken that we don't check for deleted VMs when this happens
    async.each(Object.keys(req.params.vms), function (uuid, cb) {
        var vm = common.translateVm(req.params.vms[uuid], false);
        var oldVm;

        async.waterfall([
            function loadExistingVm(done) {
                req.app.moray.getVm({uuid: uuid},
                    function onGetVm(err, existingVm) {
                        oldVm = existingVm;
                        return done(err);
                    });
            },
            function _checkStateChanges(done) {
                var stateChangeError;
                var zoneStateChangeError;
                if (oldVm) {
                    stateChangeError = validStateChange(oldVm, vm);
                    if (stateChangeError) {
                        // Silently override the params' state to be the
                        // current VM's state so that updates of other
                        // properties than state can happen from clients
                        // who have a different view of the VM's state than
                        // VMAPI (e.g vm-agent).
                        vm.state = oldVm.state;
                    }

                    // Contrary to the way we deal with invalid state
                    // transitions by silently overriding them, do not silently
                    // override the zone_state property if the current PUT /vms
                    // request would trigger an invalid zone_state transition,
                    // as this would be the sign of a problem in the system.
                    zoneStateChangeError = validZoneStateChange(oldVm,
                        vm);
                    if (zoneStateChangeError) {
                        return done(zoneStateChangeError);
                    }
                }

                return done();
            },
            function _morayPut(done) {
                req.app.moray.putVm(uuid, vm, done);
            },
            function _diffVms(etag, done) {
                var diffs = [];
                var diffResults = deepDiff.diff(oldVm, vm);
                if (diffResults && diffResults.length) {
                    for (var i = 0; i < diffResults.length; i++) {
                        var path = diffResults[i].path;
                        if (path && path[0]) {
                            diffs.push(path[0]);
                        } else {
                            req.log.warn('diffResult path not properly set: %j',
                                diffResults[i]);
                        }
                    }
                }
                done(null, diffs);
            },
            function _pub(diffs, done) {
                if (diffs && diffs.length != 0) {
                    var publisher = req.app.publisher;
                    common.publishChange(publisher, VM, diffs, uuid, done);
                } else {
                    done(null);
                }
            }
        ], function _waterfallEnd(err) {
            cb(err);
        });

    }, function (err) {
        if (err) {
            return next(err);
        }

        res.send(200);
        return next();
    });
}

/*
 * Returns true if the transition from existingVm to newVm represents a
 * valid state transition, false otherwise.
 */
function validStateChange(existingVm, newVm) {
    assert.object(existingVm, 'existingVm must be an object');
    assert.object(newVm, 'newVm must be an object');

    var changingVmState = newVm.state !== undefined &&
        newVm.state !== existingVm.state;
    var existingVmBeingDestroyed =
        existingVm.transitive_state === 'destroying';

    if (existingVm.state === 'destroyed' &&
        changingVmState &&
        newVm.state !== 'destroyed' &&
        newVm.state !== 'manual_override') {
        // Once a VM is in the 'destroyed' state, it cannot change
        // its state
        if (existingVmBeingDestroyed) {
            return new errors.VMBeingDestroyedError();
        } else {
            return new errors.ChangingDestroyedVMError();
        }
    }
}

/*
 * Returns true if the transition from existingVm to newVm represents a
 * valid zone_state transition, false otherwise.
 */
function validZoneStateChange(existingVm, newVm) {
    assert.object(existingVm, 'existingVm must be an object');
    assert.object(newVm, 'newVm must be an object');

    var changingVmZoneState = newVm.zone_state != null &&
        newVm.zone_state !== existingVm.zone_state;

    if (changingVmZoneState &&
        existingVm.zone_state === 'destroyed' &&
        newVm.zone_state !== 'destroyed') {
        // Changing the zone_state of a VM that destroyed to another zone_state
        // that is *not* destroyed is invalid and results in an error.
        return new errors.ChangingDestroyedVMError();
    }
}

/*
 * Replaces a VM
 */
function putVm(req, res, next) {
    var log = req.log;
    log.trace('PutVm start');

    var existingVm = req.vm;
    var stateChangeError, zoneStateChangeError;

    if (!common.validUUID(req.params.uuid)) {
        var error = [ errors.invalidUuidErr('uuid') ];
        return next(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    // Parse whatever is needed before putting a raw object from vm-agent
    var vm = common.translateVm(req.params, false);
    var publisher = req.app.publisher;

    if (existingVm) {
        zoneStateChangeError = validZoneStateChange(existingVm, vm);
        if (zoneStateChangeError) {
            // Trying to change zone_state in a way that is not valid is an
            // error, and should not result in a slient override. For instance,
            // having vm-agent set zone_state !== 'destroyed' for a VM that had
            // previously been set to zone_state === 'destroyed' should never
            // happen, because that means the VM should have been gone from the
            // CN at that point.
            return next(zoneStateChangeError);
        }

        stateChangeError = validStateChange(existingVm, vm);
        if (stateChangeError) {
            // Silently override the params' state to be the current VM's state
            // so that updates of other properties than state can happen from
            // clients who have a different view of the VM's state than VMAPI
            // (e.g vm-agent).
            vm.state = existingVm.state;
        }

        _overrideTransitiveState(existingVm, vm);
    }

    if (vm.state === 'destroyed') {
        _destroyVm(vm, {
            publisher: req.app.publisher,
            moray: req.app.moray
        }, function vmDestroyed(err, destroyedVm) {
            if (err) {
                return next(err);
            }

            res.send(200, vm);
            return next();
        });
    } else {
        var oldVm = req.vm || {};
        async.waterfall([
            function _morayPut(cb) {
                req.app.moray.putVm(req.params.uuid, vm, cb);
            },
            function _diffVms(etag, cb) {
                var diffs = [];
                var diffResults = deepDiff.diff(oldVm, vm);
                if (diffResults && diffResults.length) {
                    for (var i = 0; i < diffResults.length; i++) {
                        var path = diffResults[i].path;
                        // Ignore destroyed as it is handled above, and also
                        // because the input data may have it not set when
                        // existing data has it set to null. This generates
                        // false positives.
                        if (path && path[0] && path !== 'destroyed') {
                            diffs.push(path[0]);
                        } else {
                            req.log.warn('diffResult not properly set: %j',
                                diffResults[i]);
                        }
                    }
                }
                cb(null, diffs);
            },
            function _pub2(diffs, cb) {
                if (diffs && diffs.length != 0) {
                    common.publishChange(publisher, VM, diffs, vm.uuid, cb);
                } else {
                    cb(null);
                }
            }
        ], function waterfallEnd2(err) {
            if (err) {
                return next(err);
            }

            res.send(200, vm);
            return next();
        });
    }
}

function _checkWfApi(req, res, next) {
    if (!req.app.wfapi.connected) {
        return next(new restify.ServiceUnavailableError('Workflow API is ' +
            'unavailable'));
    }
    return next();
}

function _loadVm(req, res, next) {
    // Add vm_uuid record so we can trace all API requests related to this VM
    req.log = req.log.child({ vm_uuid: req.params.uuid }, true);
    req.app.moray.getVm(req.params, onGetVm);

    function onGetVm(err, vm) {
        if (err) {
            next(err);
            return;
        }

        if (vm) {
            req.vm = common.translateVm(vm, false);
        }

        next();
    }
}


/*
 * Mounts vm actions as server routes
 */
function mount(server) {
    server.get({ path: '/vms', name: 'ListVms' },
        preFilterVms,
        listVms,
        renderVms);

    server.head({ path: '/vms', name: 'HeadVms' },
        preFilterVms,
        listVms);

    server.post({ path: '/vms', name: 'CreateVm' },
        interceptors.checkWfapi,
        createVm);

    server.get({ path: '/vms/:uuid/proc', name: 'GetVmProc' },
        interceptors.loadVm,
        getVmProc);

    server.get({ path: '/vms/:uuid', name: 'GetVm' },
        interceptors.loadVm,
        getVm,
        renderVms);

    server.head({ path: '/vms/:uuid', name: 'HeadVm' },
        interceptors.loadVm,
        getVm,
        renderVms);

    server.del({ path: '/vms/:uuid', name: 'DeleteVm' },
        interceptors.checkWfapi,
        interceptors.loadVm,
        deleteVm);

    server.post({ path: '/vms/:uuid', name: 'UpdateVm' },
        interceptors.checkWfapi,
        interceptors.loadVm,
        updateVm);

    server.put({ path: '/vms/:uuid', name: 'PutVm' },
        interceptors.checkWfapi,
        _loadVm,
        putVm);

    server.put({ path: '/vms', name: 'PutVms' },
        interceptors.checkWfapi,
        putVms);
}


// --- Exports

module.exports = {
    mount: mount
};
