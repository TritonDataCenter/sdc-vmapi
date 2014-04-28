/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var assert = require('assert');
var restify = require('restify');
var async = require('async');

var common = require('../common');
var errors = require('../errors');

var VALID_VM_ACTIONS = [
    'start',
    'stop',
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

    fields = fields.filter(function(elem, index) {
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
        req.app.cache.setState(vm.uuid, vm, vm['server_uuid'], function (err) {
            if (err) {
                return next(err, 'Error refreshing VM cached state');
            } else {
                // Allow the heartbeater to clear any marked errors
                delete req.app.heartbeater.errorVms[vm.uuid];

                req.vm = vm;
                return next();
            }
        });
    }
}



/*
 * POST /vms/:uuid
 */
function updateVm(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid }, 'UpdateVm start');
    var method;
    var action = req.params.action;
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

    switch (action) {
        case 'start':
            method = startVm;
            break;
        case 'stop':
            method = stopVm;
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

        res.send(202, { vm_uuid: req.vm.uuid, job_uuid: juuid });
        return next();
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

        res.send(202, { vm_uuid: req.vm.uuid, job_uuid: juuid });
        return next();
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

        res.send(202, { vm_uuid: req.vm.uuid, job_uuid: juuid });
        return next();
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

    if (!req.params['image_uuid']) {
        var error = [ errors.missingParamErr('image_uuid') ];
        return next(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    req.app.wfapi.createReprovisionJob(req, function (err, juuid) {
        if (err) {
            return next(err);
        }

        res.send(202, { vm_uuid: req.vm.uuid, job_uuid: juuid });
        return next();
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

        function getSubtask() {
            if (params.billing_id !== undefined ||
                    params.ram !== undefined ||
                    params.max_physical_memory !== undefined) {
                return 'resize';
            } else if (params.new_owner_uuid) {
                return 'change_owner';
            } else if (params.alias) {
                return 'rename';
            }
            return '';
        }

        // Ideally there is no simultaneous subtasks unless requests are
        // manually done
        params.subtask = getSubtask();

        req.log.debug({ params: params }, 'changeVm validated params');
        req.app.wfapi.createUpdateJob(req, params, function (err, juuid) {
            if (err) {
                return next(err);
            }

            res.send(202, { vm_uuid: req.vm.uuid, job_uuid: juuid });
            return next();
        });
    }
}



/*
 * Adds NICs to a VM
 */
function addNics(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid }, 'AddNics start');

    try {
        common.validateNetworks(req.params);
        req.app.wfapi.createAddNicsJob(req, req.params.networks, onAddNicsJob);
    } catch (err) {
        return next(err);
    }

    function onAddNicsJob(err, juuid) {
        if (err) {
            return next(err);
        }

        res.send(202, { vm_uuid: req.vm.uuid, job_uuid: juuid });
        return next();
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

        res.send(202, { vm_uuid: req.vm.uuid, job_uuid: juuid });
        return next();
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

        res.send(202, { vm_uuid: req.vm.uuid, job_uuid: juuid });
        return next();
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
        } else {
            req.log.info('VM %s marked as destroyed', vm.uuid);
            req.app.cache.delState(vm.uuid, function (cacheErr) {
                if (cacheErr) {
                    req.log.error('Could not remove VM %s state from cache',
                        vm.uuid);
                    return cb(cacheErr);
                }
                return cb(null, vm);
            });
        }
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
    req.log.trace({ vm_uuid: req.params.uuid }, 'DeleteVm start');

    if (!req.vm.server_uuid) {
        return next(new errors.UnallocatedVMError(
            'Cannot delete a VM that has not been allocated to a server yet'));
    }

    return req.app.wfapi.createDestroyJob(req, function (err, juuid) {
        if (err) {
            return next(err);
        }

        res.send(202, { vm_uuid: req.vm.uuid, job_uuid: juuid });
        return next();
    });
}



/*
 * Creates a new vm. This endpoint returns a task id that can be used to
 * keep track of the vm provision
 */
function createVm(req, res, next) {
    req.log.trace('CreateVm start');

    common.validateCreateVmParams(req.app, req.params, function (err) {
        if (err) {
            return next(err);
        }

        common.setDefaultValues(req.params);
        return req.app.wfapi.createProvisionJob(req, onProvisionJob);
    });

    function onProvisionJob(err, vmuuid, juuid) {
        if (err) {
            return next(err);
        }

        req.params.state = 'provisioning';
        req.params.uuid = vmuuid;

        // Write the VM to moray
        var vm = common.translateVm(req.params, false);
        req.app.moray.putVm(vmuuid, vm, onPutVm);

        // We don't return any error to the API client because if a write to
        // moray doesn't work VMAPI recovers automatically after getting the
        // heartbeat of the new VM
        function onPutVm(err2) {
            if (err2) {
                req.log.error({ err: err2, vm_uuid: vmuuid },
                    'Error storing provisioning VM %s on moray', vmuuid);
            } else {
                req.log.debug({ vm_uuid: vmuuid },
                    'Provisioning VM %s added to moray', vmuuid);
            }
        }

        res.send(202, { vm_uuid: vmuuid, job_uuid: juuid });
        return next();
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
            'VM \'brand\' does not support snapshots'));
    }

    req.app.wfapi.createSnapshotJob(req, function (err, juuid) {
        if (err) {
            return next(err);
        }

        res.send(202, { vm_uuid: req.vm.uuid, job_uuid: juuid });
        return next();
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

    if (!req.params['snapshot_name']) {
        var error = [ errors.missingParamErr('snapshot_name') ];
        return next(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    return req.app.wfapi.createRollbackJob(req, function (err, juuid) {
        if (err) {
            return next(err);
        }

        res.send(202, { vm_uuid: req.vm.uuid, job_uuid: juuid });
        return next();
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

    if (!req.params['snapshot_name']) {
        var error = [ errors.missingParamErr('snapshot_name') ];
        return next(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    return req.app.wfapi.createDeleteSnapshotJob(req, function (err, juuid) {
        if (err) {
            return next(err);
        }

        res.send(202, { vm_uuid: req.vm.uuid, job_uuid: juuid });
        return next();
    });
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

    server.get({ path: '/vms/:uuid', name: 'GetVm' },
                 before, getVm, renderVms);

    server.head({ path: '/vms/:uuid', name: 'HeadVm' },
                 before, getVm, renderVms);

    server.del({ path: '/vms/:uuid', name: 'DeleteVm' },
                 before, deleteVm);

    server.post({ path: '/vms/:uuid', name: 'UpdateVm' },
                  before, updateVm);
}


// --- Exports

module.exports = {
    mount: mount
};
