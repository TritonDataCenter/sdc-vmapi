/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var assert = require('assert');
var restify = require('restify');
var sprintf = require('sprintf').sprintf;

var common = require('../common');
var errors = require('../errors');

var uuid = require('node-uuid');

var VALID_VM_ACTIONS = [
    'start',
    'stop',
    'reboot',
    'update',
    'add_nics',
    'remove_nics',
    'create_snapshot',
    'rollback_snapshot',
    'delete_snapshot'
];


function validAction(action) {
    return VALID_VM_ACTIONS.indexOf(action) != -1;
}



/*
 * GET /vms
 *
 * Returns a list of vms according the specified search filter. The valid
 * query options are: owner_uuid, brand, alias, status, and ram.
 */
function listVms(req, res, next) {
    req.log.trace('ListVms start');

    return req.app.moray.countVms(req.params, function (error, count) {
        if (error) {
            return next(error);
        }

        res.header('x-joyent-resource-count', count);
        return req.app.moray.listVms(req.params, function (err, vms) {
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
                res.send(200, vms);
            }

            return next();
        });
    });
}



/*
 * GET /vms/:uuid
 */
function getVm(req, res, next) {
    req.log.trace({ uuid: uuid }, 'GetVm start');
    var m = req.vm;

    if (m.server_uuid && req.params.sync && req.params.sync == 'true') {
        return req.app.cnapi.getVm(m.server_uuid, m.uuid, true, onGetVm);
    } else {
        res.send(200, m);
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
                onPutVm(putErr, newVm);
            });

        } else {
            markAsDestroyed(req);
            res.send(200, req.vm);
            return next();
        }
    }

    // Then update VM on moray
    function onPutVm(err, vm) {
        if (err) {
            req.log.error({ err: err, uuid: vm.uuid },
                'Error storing VM on moray (force cache refresh)');
            return next(err);

        } else {
            req.log.debug('VM object %s updated on moray (refresh)', vm.uuid);
            res.send(200, vm);
            return next();
        }
    }
}



/*
 * POST /vms/:uuid
 */
function updateVm(req, res, next) {
    req.log.trace('UpdateVm start');
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
        case 'add_nics':
            method = addNics;
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

    return method.call(this, req, res, next);
}



/*
 * Starts a vm with ?action=start
 */
function startVm(req, res, next) {
    req.log.trace('StartVm start');

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
    req.log.trace('StopVm start');

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
    req.log.trace('RebootVm start');

    req.app.wfapi.createRebootJob(req, function (err, juuid) {
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
    req.log.trace('ChangeVm start');
    req.log.debug({ params: req.params }, 'changeVm req.params');

    common.validateUpdate(req.app.moray, req.vm, req.params, onValidate);

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

            res.send(202, { vm_uuid: req.vm.uuid, job_uuid: juuid });
            return next();
        });
    }
}



/*
 * Adds NICs to a VM
 */
function addNics(req, res, next) {
    req.log.trace('AddNics start');

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
 * Removes NICs from a VM
 */
function removeNics(req, res, next) {
    req.log.trace('RemoveNics start');

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
function markAsDestroyed(req, res, next) {
    if (req.params.sync && req.params.sync == 'true') {
        req.app.napi.deleteNics(req.vm, onNapiDeleted);
        req.app.moray.markAsDestroyed(req.vm, onCacheMark);
    }

    function onCacheMark(err) {
        if (err) {
            req.log.error(err, 'Error marking %s as destroyed', req.vm.uuid);
        } else {
            req.log.info('VM %s marked as destroyed', req.vm.uuid);
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
    req.log.trace('DeleteVm start');

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

    common.validateVm(req.app.moray, req.params, function (err) {
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

        // Machines that are provisioning get special treatment for a while
        req.params.state = 'provisioning';
        req.params.uuid = vmuuid;

        var vm = common.translateVm(req.params, false);
        req.app.cache.setVm(vm.uuid, vm, onSetVm);

        res.send(202, { vm_uuid: vmuuid, job_uuid: juuid });
        return next();
    }

    function onSetVm(cacheErr) {
        if (cacheErr) {
            req.log.error('Could not set new VM on cache', cacheErr);
        }
    }
}



/*
 * Snapshots a VM
 */
function createSnapshot(req, res, next) {
    req.log.trace('CreateSnapshot start');

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
    req.log.trace('RollbackSnapshot start');

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
    req.log.trace('DeleteSnapshot start');

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
                 before, listVms);

    server.head({ path: '/vms', name: 'HeadVms' },
                 before, listVms);

    server.post({ path: '/vms', name: 'CreateVm' },
                  before, createVm);

    server.get({ path: '/vms/:uuid', name: 'GetVm' },
                 before, getVm);

    server.head({ path: '/vms/:uuid', name: 'HeadVm' },
                 before, getVm);

    server.del({ path: '/vms/:uuid', name: 'DeleteVm' },
                 before, deleteVm, markAsDestroyed);

    server.post({ path: '/vms/:uuid', name: 'UpdateVm' },
                  before, updateVm);
}


// --- Exports

module.exports = {
    mount: mount
};
