/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * This contains the /vms endpoint handlers.
 */

var util = require('util');

var vasync = require('vasync');
var VError = require('verror');
var assert = require('assert-plus');
var restify = require('restify');
var sdc = require('sdc-clients');
var jsprim = require('jsprim');

var common = require('../common');
var errors = require('../errors');
var interceptors = require('../interceptors');
var mod_migrate = require('../vm-migration/migrate');

// First Platform Image supporting Bhyve VMs snapshots:
const MIN_BHYVE_SNAPSHOT_PLATFORM = '20181119T131511Z';

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
    'delete_snapshot',
    'create_disk',
    'resize_disk',
    'delete_disk',
    'migrate'
];


var DEFAULT_LIST_VM_LIMIT = common.MAX_LIST_VMS_LIMIT;
var DEFAULT_LIST_VM_OFFSET = 0;

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
    vasync.forEachPipeline({
        func: function renderOneVm(vm, cb) {
            renderSingleVm(vm, function onRenderedVm(err, newVm) {
                if (err) {
                    return cb(err);
                }
                vms.push(newVm);
                return cb();
            });
        },
        inputs: req.vms
    }, function (err) {
        respond(err, vms);
    });

    function renderSingleVm(fullVm, nextVm) {
        var vm = {};
        var uuid = fullVm.uuid;

        vasync.forEachParallel({
            func: function populateVmFields(field, cb) {
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
            },
            inputs: fields
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
            error = [ errors.invalidUuidErrorsElem('role_tags', message) ];
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

    function checkInternalMetadataSearchAvailable(_, done) {
        var err;
        var INTERNAL_METADATA_SEARCH_DATA_VER = 1;
        var internalMetadataSearchUsed;
        var latestCompletedDataMigration =
            req.app.getLatestCompletedDataMigrationForModel('vms');
        var LIST_VMS_POLYMORPHIC_PARAMS = ['internal_metadata', 'tags'];

        internalMetadataSearchUsed =
            common.hasPolymorphicParamWithName('internal_metadata',
                req.params) ||
            common.jsonPredicateFiltersOn('internal_metadata',
                req.params.predicate, LIST_VMS_POLYMORPHIC_PARAMS) ||
            common.ldapFilterFiltersOn('internal_metadata_search_array',
                req.params.query);

        req.log.trace({
            latestCompletedDataMigration: latestCompletedDataMigration,
            params: req.params
        }, 'Checking if searching on internal_metadata is available');

        if (internalMetadataSearchUsed &&
            (latestCompletedDataMigration === undefined ||
                latestCompletedDataMigration <
                    INTERNAL_METADATA_SEARCH_DATA_VER)) {
            err = new errors.DataVersionError('vms',
                INTERNAL_METADATA_SEARCH_DATA_VER, latestCompletedDataMigration,
                'internal_metadata search');
        }

        done(err);
    }

    function validateParams(_, done) {
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

    function list(_, done) {
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
                assert.finite(req.params.limit,
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

                req.vms = vms;

                return done();
            });
        });
    }

    vasync.pipeline({
        funcs: [
            validateParams,
            checkInternalMetadataSearchAvailable,
            list
        ]
    }, function allDone(err) {
        if (err) {
            req.log.error({err: err}, 'Error listing VMs');
        }
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
        error = [ errors.invalidUuidErrorsElem('vm.server_uuid') ];
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

    if (req.params.sync && req.params.sync == 'true') {
        _getVmSync(req, next);
        return;
    } else {
        next();
        return;
    }
}

/**
 * Send a response for an UpdateVm action, waiting for workflow depending on
 * whether the sync parameter is specified.
 */

function handleUpdateVMResponse(req, res, next, juuid) {
    // Allow clients to know the location of WFAPI
    res.header('workflow-api', req.app.wfapi.url);

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
 * POST /vms/:uuid
 */
function updateVm(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid }, 'UpdateVm start');
    var method;
    var action = req.params.action;
    var sync = req.params.sync;
    var error;

    if (!req.vm) {
        error = [ errors.missingParamErrorsElem('vm') ];
        return next(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    if (!action) {
        error = [ errors.missingParamErrorsElem('action') ];
        return next(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    if (!validAction(action)) {
        error = [ errors.invalidParamErrorsElem('action') ];
        return next(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    if (sync && ['true', 'false'].indexOf(sync) === -1) {
        error = [ errors.invalidParamErrorsElem('sync') ];
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
        case 'create_disk':
            method = createDisk;
            break;
        case 'resize_disk':
            method = resizeDisk;
            break;
        case 'delete_disk':
            method = deleteDisk;
            break;
        case 'migrate':
            method = mod_migrate.migrateVm;
            break;
        default:
            error = [ errors.invalidParamErrorsElem('action') ];
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
            var error = [ errors.invalidParamErrorsElem('idempotent') ];
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
            var error = [ errors.invalidParamErrorsElem('idempotent') ];
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
            error = [ errors.invalidParamErrorsElem('signal') ];
            return next(new errors.ValidationFailedError('Invalid Parameters',
                error));
        }
    }

    if (req.params.idempotent) {
        if (req.params.idempotent === true ||
            req.params.idempotent === 'true') {

            req.params.idempotent = true;
        } else {
            error = [ errors.invalidParamErrorsElem('idempotent') ];
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
            var error = [ errors.invalidParamErrorsElem('idempotent') ];
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
    var error;
    var vm = req.vm;

    if (['joyent', 'joyent-minimal', 'lx'].indexOf(vm.brand) === -1) {
        return next(new errors.BrandNotSupportedError(
            'VM \'brand\' does not support reprovision'));
    }

    if (!req.params.image_uuid) {
        error = [ errors.missingParamErrorsElem('image_uuid') ];
        return next(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    if (!common.validUUID(req.params.image_uuid)) {
        error = [ errors.invalidUuidErrorsElem('image_uuid') ];
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

        // work around a mid-2018 to early-2019 VM.js platform bug, which causes
        // resize jobs to fail on VMs with no tmpfs, even when the actual VM
        // successfully resized
        if (params.tmpfs == undefined && req.vm.tmpfs === 0) {
            req.log.debug('changeVm set param.tmpfs to 0 since vm.tmpfs is 0');
            params.tmpfs = 0;
        }

        req.app.wfapi.createUpdateJob(req, params, function (err, juuid) {
            if (err) {
                return next(err);
            }

            return handleUpdateVMResponse(req, res, next, juuid);
        });
    }
}


/*
 * For an array of MACs, load the corresponding NICs from NAPI so that they can
 * be added to the zone.
 */
function loadNicsByMac(req, cb) {
    var macs = req.params.macs;
    var napi = req.app.napi;

    if (!macs) {
        cb(new VError('No MACs specified'));
        return;
    }

    function getNicFromMac(mac, next) {
        napi.getNic(mac, function getNic(err, nic) {
            if (err) {
                return next(err);
            }

            req.add_nics.push(nic);
            addFabricNatNic(req, nic);
            next();
        });

    }

    vasync.forEachPipeline({
        func: getNicFromMac,
        inputs: macs
    }, function done(err) {
        if (err) {
            cb(err);
        } else {
            req.log.info({ nics: req.add_nics }, 'NICs allocated');
            cb();
        }
    });
}

/*
 * Adds NICs to a VM
 */
function addNics(req, res, next) {
    var params = req.params;

    req.log.trace({ vm_uuid: params.uuid }, 'AddNics start');

    function doAddNics(_, cb) {
        var config = req.app.options;

        // When adding a nic if a fabric nat is wanted but hasn't been setup yet
        // we will need to pass in sdc_nat_pool to the workflow job
        // This is also done in the createVm() code path which sets all the VM
        // defaults via common.setDefaultValues()
        if (config.overlay && config.overlay.enabled) {
            params.sdc_nat_pool = config.overlay.natPool;
        }

        req.app.wfapi.createAddNicsJob(req, function onAddNicsJob(err, juuid) {
            if (err) {
                cb(err);
                return;
            }

            handleUpdateVMResponse(req, res, cb, juuid);
        });
    }

    vasync.pipeline({
        arg: req,
        funcs: [
            getNicTagReqs,
            getNicTags,
            checkServerNicTags,
            provisionNics,
            doAddNics
    ]}, function addNicsDone(err, results) {
        if (err) {
            cleanupNics(req, function nicCleanupAttempt() {
                req.log.info({err: err}, 'nics cleaned up, returning error');
                next(err);
            });
            return;
        }
        next(err);
    });
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
 * Add disk to a VM
 */
function createDisk(req, res, next) {
    var params = req.params;
    var slot = params.pci_slot;
    var size = params.size;
    var diskUuid = params.disk_uuid;
    var vm = req.vm;
    var paramErr;
    var found;

    req.log.trace({ vm_uuid: vm.uuid }, 'CreateDisk start');

    if (diskUuid !== undefined) {
        if (!common.validUUID(diskUuid)) {
            var msg = diskUuid + ' is not a UUID';
            paramErr = [ errors.invalidUuidErrorsElem('disk_uuid', msg) ];
            return next(new errors.ValidationFailedError(
                        'Invalid disk_uuid', paramErr));
        }

        found = vm.disks.filter(function matchUuid(disk) {
            return disk.uuid === diskUuid;
        })[0];

        if (found) {
            paramErr = [ errors.invalidParamErrorsElem('disk_uuid',
                'Already in use') ];
            next(new errors.ValidationFailedError('Invalid Parameters',
                 paramErr));
            return;
        }
    }

    if (slot !== undefined) {
        try {
            common.validatePciSlot(params);
        } catch (e) {
            next(e);
            return;
        }

        found = vm.disks.filter(function matchSlot(disk) {
            return disk.pci_slot === slot;
        })[0];

        if (found) {
            next(new errors.ValidationFailedError(
                'Invalid Parameters',
                [ errors.invalidParamErrorsElem('pci_slot', 'Already in use') ]
));
            return;
        }
    }

    if (isNaN(size) && size !== 'remaining') {
        next(new errors.ValidationFailedError(
            'Invalid Parameters',
            [ errors.invalidParamErrorsElem('size', 'Not a valid value') ]
        ));
        return;
    } else if (vm.brand !== 'bhyve') {
        next(new errors.BrandNotSupportedError('Can only create disks on ' +
            'bhyve VMs'));
        return;
    } else if (!vm.flexible_disk_size) {
        next(new errors.VmWithoutFlexibleDiskSizeError());
        return;
    } else if (vm.state !== 'stopped') {
        next(new errors.VmNotStoppedError());
        return;
    }

    var currentAggrSize = vm.disks.reduce(function addSize(acc, disk) {
        return acc + disk.size;
    }, 0);

    if (size !== 'remaining' &&
               currentAggrSize + size > vm.flexible_disk_size) {
        next(new errors.InsufficientDiskSpaceError());
        return;
    }

    var args = {
        subtask: 'create_disk',
        add_disks: [ {
            uuid: diskUuid,
            pci_slot: slot,
            size: size,
            model: 'virtio'
        } ]
    };

    req.app.wfapi.createUpdateJob(req, args, function onDiskJob(err, juuid) {
        if (err) {
            next(err);
            return;
        }

        handleUpdateVMResponse(req, res, next, juuid);
    });
}



/*
 * Resize a VM's disk
 */
function resizeDisk(req, res, next) {
    var params = req.params;
    var size = +params.size;
    var slot = params.pci_slot;
    var shrink = params.dangerous_allow_shrink;
    var vm = req.vm;

    req.log.trace({ vm_uuid: vm.uuid }, 'ResizeDisk start');

    try {
        common.validatePciSlot(params);
    } catch (e) {
        next(e);
        return;
    }

    var found = vm.disks.filter(function matchSlot(disk) {
        return disk.pci_slot === slot;
    })[0];

    if (!found) {
        next(new restify.ResourceNotFoundError('Disk not found'));
        return;
    } else if (isNaN(size)) {
        next(new errors.ValidationFailedError(
            'Invalid Parameters',
            [ errors.invalidParamErrorsElem('size', 'Not a valid number') ]
        ));
        return;
    } else if (shrink !== undefined && typeof (shrink) !== 'boolean') {
        next(new errors.ValidationFailedError(
            'Invalid Parameters',
            [ errors.invalidParamErrorsElem('dangerous_allow_shrink',
                'Not a boolean') ]
        ));
        return;
    } else if (vm.brand !== 'bhyve') {
        next(new errors.BrandNotSupportedError('Can only resize disks on ' +
             'bhyve VMs'));
        return;
    } else if (!vm.flexible_disk_size) {
        next(new errors.VmWithoutFlexibleDiskSizeError());
        return;
    } else if (vm.state !== 'stopped') {
        next(new errors.VmNotStoppedError());
        return;
    } else if (found.size > size && !shrink) {
        next(new errors.ValidationFailedError(
            'Invalid Parameters',
            [ errors.invalidParamErrorsElem('size',
                'Reducing disk size is a dangerous operation') ]
        ));
        return;
    }

    var aggrSize = vm.disks.reduce(function addSize(acc, disk) {
        return acc + disk.size;
    }, 0);

    if (aggrSize - found.size + size > vm.flexible_disk_size) {
        next(new errors.InsufficientDiskSpaceError());
        return;
    }

    var args = {
        subtask: 'resize_disk',
        update_disks: [ {
            path: found.path,
            size: size,
            dangerous_allow_shrink: shrink || false
        } ]
    };

    req.app.wfapi.createUpdateJob(req, args, function onDiskJob(err, juuid) {
        if (err) {
            next(err);
            return;
        }

        handleUpdateVMResponse(req, res, next, juuid);
    });
}



/*
 * Removes a disk from a VM
 */
function deleteDisk(req, res, next) {
    var params = req.params;
    var slot = params.pci_slot;
    var vm = req.vm;

    req.log.trace({ vm_uuid: vm.uuid }, 'DeleteDisk start');

    try {
        common.validatePciSlot(params);
    } catch (e) {
        next(e);
        return;
    }

    var found = vm.disks.filter(function matchSlot(disk) {
        return disk.pci_slot === slot;
    })[0];

    if (!found) {
        next(new restify.ResourceNotFoundError('Disk not found'));
        return;
    } else if (found.boot) {
        next(new errors.ValidationFailedError(
            'Invalid Parameters',
            [ errors.invalidParamErrorsElem('slot', 'Cannot remove boot disk') ]
        ));
        return;
    } else if (vm.brand !== 'bhyve') {
        next(new errors.BrandNotSupportedError('Can only delete disks on ' +
            'bhyve VMs'));
        return;
    } else if (!vm.flexible_disk_size) {
        next(new errors.VmWithoutFlexibleDiskSizeError());
        return;
    } else if (vm.state !== 'stopped') {
        next(new errors.VmNotStoppedError());
        return;
    }

    var args = {
        subtask: 'delete_disk',
        remove_disks: [found.path]
    };

    req.app.wfapi.createUpdateJob(req, args, function onDiskJob(err, juuid) {
        if (err) {
            next(err);
            return;
        }

        handleUpdateVMResponse(req, res, next, juuid);
    });
}



/*
 * Deletes a vm
 */
function deleteVm(req, res, next) {
    assert.object(req.vm, 'req.vm must be an object');

    var sync = req.params.sync;

    req.log.trace({ vm_uuid: req.params.uuid }, 'DeleteVm start');

    if (sync && ['true', 'false'].indexOf(sync) === -1) {
        var error = [ errors.invalidParamErrorsElem('sync') ];
        next(new errors.ValidationFailedError('Invalid Parameters', error));
        return;
    } else {
        req.params.sync = (sync === 'true' ? true : false);
    }

    /*
     * If the vm has no server_uuid, then starting a destroy workflow would fail
     * right after it starts, since the part of the workflow that would start
     * the destroy VM task wouldn't be able to determine on which CN to start
     * it. In this case, instead of taking some space in the workflow's queue
     * (slowing down any other worfklow) and waiting for the workflow to fail,
     * just error right away. It's faster, and uses far less resources of the
     * overall system. We can't mark the VM as destroyed because in this case
     * the VM might actually exist somewhere.
     */
    if (req.vm.server_uuid === undefined || req.vm.server_uuid === null) {
        next(new restify.errors.ConflictError('Cannot delete a VM with no ' +
            'server_uuid'));
    } else {
        req.app.wfapi.createDestroyJob(req, function (jobErr, juuid) {
            if (jobErr) {
                next(jobErr);
                return;
            }

            handleUpdateVMResponse(req, res, next, juuid);
        });
    }
}

function _cnapiServerNotFoundError(err) {
    return err && err.body && err.body.code === 'ResourceNotFound';
}

/*
 * Optional when role_tags are passed to the provision request
 */
function createRoleTags(req, cb) {
    var error, message;
    var roleTags = req.params.role_tags;

    if (!Array.isArray(roleTags) || Object.keys(roleTags).length === 0) {
        message = 'Must be an array of UUIDs';
        error = [ errors.invalidParamErrorsElem('role_tags', message) ];
        return cb(new errors.ValidationFailedError(
                    'Invalid VM parameters', error));
    }

    roleTags.forEach(function (roleTag) {
        if (!common.validUUID(roleTag)) {
            message = roleTag + ' is not a UUID';
            error = [ errors.invalidUuidErrorsElem('role_tags', message) ];
            return cb(new errors.ValidationFailedError(
                        'Invalid VM parameters', error));
        }
    });

    req.app.moray.putVmRoleTags(req.params.uuid, roleTags, cb);
}

/*
 * preFilterNetworks will gather network info ahead of time for each of
 * the networks passed into vmapi. This avoids looking up the same info
 * in napi more than once.
 *
 * filteredNetworks fields:
 *  - netInfo: all of the napi info for each network
 *  - networks: validated and transformed req.params.networks
 *  - fabrics: array of fabric network uuids if any were passed in
 *  - pools: array of pool network uuids if any were passed in
 *  - nics: eventual storage for nics as they are provisioned
 */
function preFilterNetworks(req, res, next) {
    req.filteredNetworks = {};

    var filteredNetworks = req.filteredNetworks;
    filteredNetworks.netInfo = [];
    filteredNetworks.networks = [];
    filteredNetworks.fabrics = [];
    filteredNetworks.pools = [];
    filteredNetworks.nics = [];

    // If we came in via addNics we might not have any networks to process
    if (!req.params.networks) {
        req.log.info({params: req.params}, 'no need to preFilterNetworks');
        next();
        return;
    }

    var napi = req.app.napi;

    try {
        common.validateNetworks(req.params);
    } catch (err) {
        next(err);
        return;
    }

    var networks = req.params.networks;
    var owner_uuid = req.params.owner_uuid || req.vm.owner_uuid;

    assert.uuid(owner_uuid, 'owner_uuid');

    function findNetwork(netId, cb) {
        var params;

        if (common.validUUID(netId)) {
            params = { params: { provisionable_by: owner_uuid }};
            napi.getNetwork(netId, params, cb);
        } else {
            params = { name: netId };
            napi.listNetworks(params, cb);
        }
    }

    function findNetworkPool(netId, cb) {
        var params;

        if (common.validUUID(netId)) {
            params = { params: { provisionable_by: owner_uuid }};
            napi.getNetworkPool(netId, params, cb);
        } else {
            params = { name: netId };
            napi.listNetworkPools(params, cb);
        }
    }

    /*
     * We need to get all of the networks so we know the following:
     * - the account can own a nic on the network
     * - if the network is a fabric
     * - if the network is a pool
     */
    function getNetworkInfo(network, callback) {
        var netId;
        if (network.ipv4_uuid !== undefined) {
            netId = network.ipv4_uuid;
        } else if (network.name !== undefined) {
            netId = network.name;
        }

        assert.string(netId, 'netId');

        findNetworkPool(netId, function (fpErr, pools) {
            if (fpErr) {
                if (!VError.hasCauseWithName(fpErr,
                    'ResourceNotFoundError')) {
                        callback(new VError(fpErr,
                            'Failed to find network pool "%s"', netId));
                    return;
                }
            }

            /*
             * Prior to NAPI-121, using a "name" filter for a network pool
             * would either be silently ignored (or rejected post NAPI-343).
             * In case we're talking to a NAPI that's ignored our parameter,
             * we filter the results to avoid using an incorrect pool.
             */
            if (Array.isArray(pools)) {
                pools = pools.filter(function (pool) {
                    return pool.name === netId;
                });
                if (pools.length === 0) {
                    req.log.info('No pools with name %s found, will try '
                        + 'networks', netId);
                } else if (pools.length === 1) {
                    filteredNetworks.pools.push(pools[0].uuid);
                    filteredNetworks.netInfo.push(pools[0]);
                    callback(null, pools[0].uuid);
                    return;
                } else {
                    callback(new restify.UnprocessableEntityError(
                        'Multiple Network Pools with name: ' + netId));
                    return;
                }
            } else if (pools) {
                filteredNetworks.pools.push(pools.uuid);
                filteredNetworks.netInfo.push(pools);
                callback(null, pools.uuid);
                return;
            }

            // couldn't find a pool with that name, look for a network istead.
            findNetwork(netId, function (fnErr, nets) {
                if (fnErr && !VError.hasCauseWithName(fnErr,
                    'ResourceNotFoundError')) {

                    callback(new VError(fnErr, 'Failed to find network "%s"',
                        netId));
                    return;
                }

                // Did we get the network from list or get?
                var net = (Array.isArray(nets) ? nets[0] : nets);

                // No net if NAPI returns an empty array or if we got a 404
                if (!net) {
                    callback(new restify.UnprocessableEntityError(
                        'No such Network or Pool with id/name: "' +
                        netId + '"'));
                    return;
                }

                if (net.fabric) {
                    filteredNetworks.fabrics.push(net.uuid);
                }
                filteredNetworks.netInfo.push(net);
                callback(null, net.uuid);
            });
        });
    }

    function lookupNetwork(network, cb) {
        getNetworkInfo(network, function (err, uuid) {
            if (err) {
                cb(err);
                return;
            }
            network.ipv4_uuid = uuid;
            delete network.name;
            filteredNetworks.networks.push(network);
            cb();
        });
    }

    vasync.forEachPipeline({
        func: lookupNetwork,
        inputs: networks
    }, function (err, results) {
        if (err) {
            next(err);
            return;
        }
        req.log.info({filteredNetworks: filteredNetworks},
            'filteredNetworks complete');

        next();
        return;
    });
}

/*
 * Used in the createVm path to assign a primary nic
 * if the user did not already define one.
 */
function setPrimaryNic(req, res, next) {
    var filteredNetworks = req.filteredNetworks;
    assert.object(filteredNetworks, 'filteredNetworks');

    var networks = filteredNetworks.networks;
    assert.arrayOfObject(networks, 'networks');

    // set the primary nic
    var primaryFound = networks.some(function (net) {
        return net.primary;
    });

    if (!primaryFound && networks.length > 0)
        networks[0].primary = true;

    next();
}

/*
 * If this is a nic on a fabric, has no gateway provisioned, and the network
 * requests an internet NAT, add it.
 */
function addFabricNatNic(req, fNic) {
    if (fNic && fNic.fabric && fNic.gateway && !fNic.gateway_provisioned &&
        fNic.ip !== fNic.gateway && fNic.internet_nat) {

        req.fabricNatNics.push(fNic);
    }
}

/*
 * Provisions additional NICs for a zone in NAPI if networks were provided to
 * the job.
 *
 * The networks list can contain a not null ip attribute on each object, which
 * denotes that we want to allocate that given IP for the correspondent network.
 */
function provisionNetNics(req, cb) {
    var filteredNetworks = req.filteredNetworks;
    var networks = filteredNetworks.networks;
    var napi = req.app.napi;
    var inst_uuid = req.params.uuid;
    var owner_uuid = req.params.owner_uuid || req.vm.owner_uuid;
    var nics = filteredNetworks.nics;
    var macs = req.params.macs;

    assert.array(networks, 'networks');
    assert.equal(macs, undefined, 'macs');

    networks.forEach(function (net) {
        // Make absolutely sure we're never overriding NAPI's network
        // owner checks:
        delete net.check_owner;
    });

    // Return a new copy for every time we provision a new NIC and avoid
    // accidentally reusing an object
    function nicParams() {
        var nic_params = {
            owner_uuid: owner_uuid,
            belongs_to_uuid: inst_uuid,
            belongs_to_type: 'zone',
            state: 'provisioning',
            cn_uuid: req.vm.server_uuid
        };

        if (req.serverNicTags) {
            nic_params.nic_tags_available = req.serverNicTags;
        }

        return nic_params;
    }

    var antiSpoofParams = [
        'allow_dhcp_spoofing',
        'allow_ip_spoofing',
        'allow_mac_spoofing',
        'allow_restricted_traffic'
    ];

    /*
     * Get current list of NICs that might have been provisioned ahead of
     * time. This is done in some places when an IP address needs to be
     * known ahead of time. For example, Zookeeper instances in Manta have
     * their NICs created before provisioning instances, so that they can be
     * configured to know each other's addresses before booting.
     */
    napi.listNics({
        owner_uuid: owner_uuid,
        belongs_to_uuid: inst_uuid,
        belongs_to_type: 'zone'
    }, function asyncProvisionNics(err, currentNics) {
        if (err) {
            cb(err);
            return;
        }

        function createNic(network, done) {
            // If there is at least one provisioned NIC in one of the
            // networks provided, skip napi.provisionNic for this network
            var netNics = currentNics.filter(function (nic) {
                return (nic.network_uuid && nic.network_uuid ===
                    network.ipv4_uuid);
            });

            if (netNics.length > 0) {
                nics.push.apply(nics, netNics);
                done();
                return;
            }

            var params = nicParams();
            if (network.ipv4_ips !== undefined)
                params.ip = network.ipv4_ips[0];

            if (network.primary !== undefined)
                params.primary = network.primary;

            antiSpoofParams.forEach(function (spoofParam) {
                if (network.hasOwnProperty(spoofParam)) {
                    params[spoofParam] = network[spoofParam];
                }
            });

            napi.provisionNic(network.ipv4_uuid, params,
                function (suberr, nic) {
                if (suberr) {
                    done(suberr);
                } else {
                    nics.push(nic);
                    addFabricNatNic(req, nic);
                    done();
                }
            });
        }

        vasync.forEachPipeline({
            func: createNic,
            inputs: networks
        }, function (err2, results) {
            if (err2) {
                cb(err2);
            } else {
                req.log.info({ nics: req.filteredNetworks.nics },
                    'NICs allocated');
                req.add_nics = req.filteredNetworks.nics;
                cb();
            }
        });
    });

}

/*
 * It's better to preprovision NICs up front so that issues like running out of
 * IP addresses or being unable to provide an explicitly requested IP address
 * can be reported back to the customer, instead of silently disappearing in
 * the workflow job's details.
 *
 * - Keep track of all NICs created in case we hit an error and need to
 *   cleanup.
 * - Keep track of fabric NICs for NAT zone provisioning later.
 */
function provisionNics(req, cb) {
    var networks = req.filteredNetworks.networks;
    var macs = req.params.macs;

    req.fabricNatNics = [];
    req.add_nics = [];

    if (macs) {
        assert.ok(!networks || networks.length === 0);
        loadNicsByMac(req, cb);
    } else if (networks && networks.length > 0) {
        assert.ok(!macs || macs.length == 0);
        provisionNetNics(req, cb);
    } else {
        cb(new errors.ValidationFailedError(
            'Invalid Parameters',
            [ errors.missingParamErrorsElem('missing networks or macs') ]
        ));
    }
}

// Cleanup pre-provisioned nics
function cleanupNics(req, cb) {
    var napi = req.app.napi;
    assert.ok(napi, 'napi');

    assert.object(req.filteredNetworks);
    var nics = req.filteredNetworks.nics;

    // If we never provisioned any nics we should return early
    if (nics.length === 0) {
        cb();
        return;
    }

    assert.arrayOfObject(nics, 'nics');

    function deleteNic(nic, done) {
        napi.deleteNic(nic.mac, function (napiErr) {
            if (napiErr) {
                req.log.error({ err: napiErr, nic: nic },
                    'Error deleting pre-provisioned NIC %s', nic.mac);
                done(napiErr);
                return;
            }
            req.log.info({ nic: nic },
                'successfully cleaned up pre-provisioned NIC %s', nic.mac);
            done();
        });
    }

    vasync.forEachParallel({
        func: deleteNic,
        inputs: nics
    }, function (err, results) {
        // We ignore all errors in this case and let the caller
        // return the original error
        cb();
    });
}

function refreshVmOnError(req, next) {
    if (!req.vm || !req.vm.uuid) {
        req.log.warn({vm: req.vm}, 'cannot refresh VM, no UUID provided');
        next();
        return;
    }
    _getVmSync(req, next);
}


function releaseVMTicket(req, next) {
    var ticket = req.vmTicket;
    if (!ticket) {
        req.log.warn('No vmTicket to release');
        next();
        return;
    }

    // vmapi's custom cnapi client is no good here, but that should be removed
    // as part of TRITON-1295, and this fixed up accordingly.
    var cnapi = new sdc.CNAPI({
        url: req.app.options.cnapi.url,
        headers: { 'x-request-id': req.getId() }
    });

    cnapi.waitlistTicketRelease(ticket.uuid, function (err) {
        if (err) {
            req.log.warn({err: err, ticket: ticket},
                'error releasing CNAPI waitlist VM ticket');
        }
        next(err);
    });
}

/*
 * Allocate a server for this VM.  Selects a server for the VM. This
 * function will send VM, image, package and NIC tag requirements to DAPI, and
 * let it figure out which server best fits the requirements.  Note that if you
 * pass params['server_uuid'], this function will terminate early, because you
 * have already specified the server you want to provision.  We still however,
 * need to get the proper tickets from cnapi for synchronization.
 *
 * Here we serialize the compute node designation api (DAPI) portion of the
 * action via the CNAPI waitlist to ensure that only one allocation happens
 * at a time. In addition to serializing all the designations via the waitlist,
 * we will create waitlist tickets for the provision itself.  DAPI will use the
 * provision tickets to know whether there are in-flight provisions and prevent
 * multiple concurrent provisions from inadvertently all ending up on the same
 * compute node.
 */
function allocateServer(req, callback) {
    // vmapi's custom cnapi client is no good here, but that should be removed
    // as part of TRITON-1295, and this fixed up accordingly.
    var cnapi = new sdc.CNAPI({
        url: req.app.options.cnapi.url,
        headers: { 'x-request-id': req.getId() }
    });

    var params = req.params;

    function acquireAllocationTicket(_, next) {
        var newTicket = {
            scope: 'vm-allocate',
            id: 'global',
            expires_at: (new Date(
                Date.now() + 60 * 1000).toISOString()),
            action: 'allocate'
        };

        cnapi.waitlistTicketCreate('default', newTicket, onCreate);

        function onCreate(err, ticket) {
            if (err) {
                next(err);
                return;
            }

            req.allocationTicket = ticket.queue.filter(function (tick) {
                return (tick.uuid === ticket.uuid);
            })[0];

            req.log.info({ ticket: req.allocationTicket },
                'got allocationTicket');
            next();
        }
    }

    function waitOnAllocationTicket(_, next) {
        var allocationTicket = req.allocationTicket;

        if (allocationTicket.status === 'active') {
            return next();
        }

        cnapi.waitlistTicketWait(allocationTicket.uuid, next);
    }

    function getAllocation(_, next) {
        var nicTagReqs = req.nicTagReqs;
        var pkg = params.package;
        var img = params.image;

        var cnapi_json = restify.createJsonClient({
            url: req.app.options.cnapi.url,
            headers: { 'x-request-id': req.getId() }
        });

        if (!nicTagReqs) {
            var nicerr = [ errors.missingParamErrorsElem('nictag') ];
            next(new errors.ValidationFailedError('Invalid Parameters',
                nicerr));
            return;
        }

        if (!img) {
            var imgerr = [ errors.missingParamErrorsElem('image') ];
            next(new errors.ValidationFailedError('Invalid Parameters',
                imgerr));
            return;
        }

        if (req.vm.server_uuid) {
            assert.equal(req.vm.server_uuid, params.server_uuid, 'server uuid');
            req.log.debug({ server_uuid: req.vm.server_uuid },
                'Server uuid is present, no need to get allocation from DAPI');
            next();
            return;
        }

        /*
         * In case we're talking to an older DAPI from before heterogeneous
         * pools were supported, we select the first tag from each list of
         * alternatives.
         */
        var nicTags = nicTagReqs.map(function extractFirstTag(arr) {
            return arr[0];
        });

        var payload = {
            vm: params,
            image: img,
            package: pkg,
            nic_tags: nicTags,
            nic_tag_requirements: nicTagReqs
        };

        payload.vm.vm_uuid = params.uuid;

        req.log.info({ dapiPayload: payload }, 'Payload sent to DAPI');

        cnapi_json.post('/allocate', payload,
            function afterAllocate(err, areq, res, body) {

            if (err) {
                next(err);
                return;
            }

            var server = body.server;
            var server_uuid = server.uuid;
            req.vm.server_uuid = server_uuid;
            params.imgapiPeers = body.imgapiPeers;

            req.server_info = {
                sysinfo: {
                    'Network Interfaces': server.sysinfo['Network Interfaces'],
                    'Virtual Network Interfaces':
                        server.sysinfo['Virtual Network Interfaces']
                }
            };

            req.log.info('VM allocated to Server: ', server_uuid);
            next();
        });
    }

    function putVmInMoray(_, next) {
        var vmuuid = params.uuid;

        // For a VM with do_not_inventory, don't write the moray record at all.
        if (params.do_not_inventory) {
            req.log.debug({vm_uuid: vmuuid}, 'Provisioning VM %s - not ' +
                'writing moray record as do_not_inventory is set', vmuuid);
            next();
            return;
        }

        var vmparams = jsprim.deepCopy(params);

        vmparams.state = 'provisioning';
        vmparams.create_timestamp = (new Date());
        vmparams.server_uuid = req.vm.server_uuid;

        var vm = common.translateVm(vmparams);

        req.app.moray.putVm(vmuuid, vm, {}, function (err) {
            if (err) {
                // When provision has been queued and moray fails putobject
                // we should be able to see the VM show up eventually when
                // vm-agent sees it.
                req.log.error({ err: err, vm_uuid: vmuuid },
                    'Error storing provisioning VM %s in moray', vmuuid);
            } else {
                req.log.debug({ vm_uuid: vmuuid },
                    'Provisioning VM %s added to moray', vmuuid);
            }

            next();
        });

    }

    function acquireVMTicket(_, next) {
        var server_uuid = req.vm.server_uuid;
        var newTicket = {
            scope: 'vm',
            id: params.uuid,
            expires_at: (new Date(
                Date.now() + 600 * 1000).toISOString()),
            action: 'provision'
        };

        newTicket.extra = {
            owner_uuid: params.owner_uuid,
            max_physical_memory: params.max_physical_memory,
            cpu_cap: params.cpu_cap,
            quota: params.quota,
            brand: params.brand,
            disks: params.disks
        };

        if (['bhyve', 'kvm'].indexOf(params.brand) !== -1 &&
            params.image) {

            newTicket.extra.image_size = params.image.image_size;
        }

        cnapi.waitlistTicketCreate(server_uuid, newTicket, onCreate);

        function onCreate(err, ticket) {
            if (err) {
                next(err);
                return;
            }

            req.vmTicket = ticket.queue.filter(function (tick) {
                return (tick.uuid === ticket.uuid);
            })[0];

            req.log.info({ ticket: req.vmTicket }, 'got vmTicket');
            next();
        }
    }

    function releaseAllocationTicket(_, next) {
        var allocationTicket = req.allocationTicket;

        assert.object(allocationTicket, 'allocationTicket');

        cnapi.waitlistTicketRelease(req.allocationTicket.uuid,
            function (err) {

            if (err) {
                req.log.warn({err: err, ticket: req.allocationTicket},
                    'error releasing CNAPI waitlist allocation ticket');
            }
            next();
        });
    }

    function waitForVMTicket(_, next) {
        var ticket = req.vmTicket;

        if (ticket.status === 'active') {
            next();
            return;
        }
        cnapi.waitlistTicketWait(ticket.uuid, next);
    }

    vasync.pipeline({
        arg: req,
        funcs: [
            getNicTagReqs,
            acquireAllocationTicket,
            waitOnAllocationTicket,
            getAllocation,
            putVmInMoray,
            acquireVMTicket,
            releaseAllocationTicket,
            waitForVMTicket
    ]}, function allocateServerDone(err, results) {
        if (err) {
            vasync.pipeline({
                arg: req,
                funcs: [
                    refreshVmOnError,
                    releaseVMTicket,
                    releaseAllocationTicket
            ]}, function (err2, res2) {
                // Ignore errors from clean up.
                callback(err);
            });
            return;
        }
        delete req.allocationTicket;
        callback();
    });
}


/*
 * Perform the same logic that DAPI performs on the sysinfo payload,
 * minus the parts about online/offline NICs, since we're either
 * adding new NICs to a VM or performing a manual server selection.
 */
function getNicTags(req, callback) {
    function extractServerNicTags(err, server) {
        if (err) {
            callback(err);
            return;
        }

        var interfaces = server.sysinfo['Network Interfaces'] || {};
        var vnics = server.sysinfo['Virtual Network Interfaces'] || {};
        var serverTags = {};

        Object.keys(interfaces).forEach(function extractTags(nicName) {
            var nic = interfaces[nicName];
            var nicTags = nic['NIC Names'];

            nicTags.forEach(function (tag) {
                serverTags[tag] = true;
            });
        });

        Object.keys(vnics).forEach(function extractOverlayTags(nicName) {
            var nic = vnics[nicName];
            var nicTags = nic['Overlay Nic Tags'] || [];

            for (var i = 0; i < nicTags.length; i++) {
                serverTags[nicTags[i]] = true;
            }
        });

        req.serverNicTags = Object.keys(serverTags);

        callback();
    }

    if (req.server_info) {
        extractServerNicTags(null, req.server_info);
    } else {
        var cnapi = req.app.cnapi;
        cnapi.getServer(req.vm.server_uuid, extractServerNicTags);
    }
}


/*
 * Checks that the server has the NIC tags for every network or NIC that was
 * passed to it. While this task is usually done in DAPI when determining where
 * to place a VM, it also needs to be done when adding a new NIC to a VM, or
 * when the server_uuid has been manually specified during provisioning.
 */
function checkServerNicTags(req, callback) {
    var macs = req.params.macs;
    var error;

    function done(err) {
        if (err) {
            req.log.error({err: err}, 'Error checking server nictags');
        }
        callback(err);
    }

    if (macs) {
        /*
         * If 'macs' was passed, we're dealing with pre-created NICs, so we need
         * to pull the NICs from NAPI first.
         */
        var napi = req.app.napi;

        vasync.forEachPipeline({
            func: function lookupMAC(mac, next) {
                napi.getNic(mac, function checkTagOkay(err, nic) {
                    if (err) {
                        next(err);
                        return;
                    }

                    var nicTag = nic.nic_tag;

                    if (!nicTag) {
                        error = [ errors.invalidParamErrorsElem('nic') ];
                        next(new errors.ValidationFailedError('NIC ' + mac +
                            'does not have a nitag', error));
                        return;
                    }

                    /*
                     * This hack is to split the NIC tag off from the vnet_id,
                     * which fabric NICs have embedded in their nic_tag
                     * attribute.
                     */
                    var overlay = nicTag.match(/^(.+)\/\d+$/);
                    nicTag = overlay ? overlay[1] : nicTag;

                    if (req.serverNicTags.indexOf(nicTag) === -1) {
                        error = [ errors.invalidParamErrorsElem('server') ];
                        next(new errors.ValidationFailedError(
                            'Server does not have NIC tag: ' + nicTag, error));
                        return;
                    }

                    next();
                });
            },
            inputs: macs
        }, done);
        return;
    }

    /*
     * Otherwise we're dealing with networks. The nic_tag requirements for
     * these networks and pools were already loaded by getNicTags().  We need
     * to make sure that the specified server satisfies at least one of the
     * tags required for each network and pool.
     */
    var serverTags = {};
    req.serverNicTags.forEach(function extractServerTag(tag) {
        serverTags[tag] = true;
    });

    for (var i = 0; i < req.nicTagReqs.length; i++) {
        var reqs = req.nicTagReqs[i];
        var satisfied = false;

        for (var j = 0; j < reqs.length; j++) {
            if (serverTags[reqs[j]]) {
                satisfied = true;
                break;
            }
        }

        if (!satisfied) {
            error = [ errors.invalidParamErrorsElem('server') ];
            done(new errors.ValidationFailedError(
                'Server must have one of the following NIC tags: ' +
                reqs.join(', ')));
            return;
        }
    }

    done();
}

function getNicTagReqs(req, next) {
    var networks = req.params.networks;
    var filteredNetworks = req.filteredNetworks;

    if (req.params.macs && !networks) {
        return next();
    }

    req.nicTagReqs = [];

    function pushTags(net) {
        if (net.nic_tags_present) {
            req.nicTagReqs.push(net.nic_tags_present);
        } else {
            req.nicTagReqs.push([ net.nic_tag ]);
        }
    }

    filteredNetworks.netInfo.forEach(function (net) {
        pushTags(net);
    });

    req.log.info({ nicTagReqs: req.nicTagReqs },
        'NIC Tag requirements retrieved');

    next();
}

/*
 * Creates a new vm. This endpoint returns a task id that can be used to
 * keep track of the vm provision
 */
function createVm(req, res, next) {
    req.log.trace('CreateVm start');

    var sync = req.params.sync;

    // Create the vm object here so that we can store things in it during the
    // provision process and leave 'params' alone.  This also allows for more
    // common code in the create and update paths.
    req.vm = {};

    vasync.pipeline({
        arg: req,
        funcs: [
            validateCreateVmParams,
            checkAllNfsVolumesReachable,
            allocateServer,
            getNicTags,
            checkServerNicTags,
            provisionNics
        ]
    }, function createVmDone(err, results) {
        if (err) {
            vasync.pipeline({
                arg: req,
                funcs: [
                    cleanupNics,
                    refreshVmOnError,
                    releaseVMTicket
            ]}, function () {
                req.log.info({err: err}, 'nics cleaned up and vmTicket ' +
                    'released, returning error');
                next(err);
            });
            return;
        }
        createProvisionJob();
    });


    function validateCreateVmParams(_, done) {
        common.validateCreateVmParams(req.app, req.params, function (err) {
            if (err) {
                return done(err);
            }

            common.setDefaultValues(req.params, {config: req.app.options});
            req.vm.uuid = req.params.uuid;
            req.vm.server_uuid = req.params.server_uuid;

            if (sync && ['true', 'false'].indexOf(sync) === -1) {
                var error = [ errors.invalidParamErrorsElem('sync') ];
                return done(new errors.ValidationFailedError('Invalid' +
                    ' Parameters',
                    error));
            } else {
                req.params.sync = (sync === 'true' ? true : false);
            }

            var locality = req.params.locality;
            if (locality) {
                var metadata = req.params.internal_metadata || {};
                metadata.locality = JSON.stringify(locality);
                req.params.internal_metadata = metadata;
            }

            done();
        });
    }


    function checkAllNfsVolumesReachable(_, done) {
        var volumes = req.params.volumes;
        var networks = req.filteredNetworks.networks;

        assert.optionalArrayOfObject(volumes, 'volumes');
        assert.arrayOfObject(networks, 'networks');

        req.log.debug('Checking volumes reachability');

        if (!volumes || volumes.length === 0) {
            req.log.debug('No volume to mount, skipping volumes reachability ' +
                'checks');
            done();
            return;
        }

        vasync.forEachParallel({
            func: function checkVolReachable(volume, checkReachableDone) {
                var ownerUuid;
                var volumeName;

                assert.object(volume, 'volume');
                volumeName = volume.name;

                assert.uuid(req.params.owner_uuid, 'req.params.owner_uuid');
                ownerUuid = req.params.owner_uuid;

                req.log.debug({
                    volume: volume,
                    networks: networks
                }, 'Checking reachability for volume');

                req.app.volapi.listVolumes({
                    name: volumeName,
                    owner_uuid: ownerUuid,
                    state: 'ready'
                }, function onListVols(listVolsErr, vols) {
                    var checkReachableErr;
                    var foundVolNetwork = false;
                    var idx;
                    var network;

                    if (listVolsErr) {
                        checkReachableErr =
                            new errors.VolumeNotReachableError('Could not ' +
                                'check reachability for volume ' + volumeName);
                        checkReachableDone(checkReachableErr);
                        return;
                    }

                    if (!vols || vols.length === 0) {
                        checkReachableDone();
                        return;
                    }

                    if (vols.length > 1) {
                        checkReachableErr =
                            new errors.VolumeNotReachableError('Could not ' +
                                'check reachability for volume ' + volumeName +
                                ' more than one volume with that name');
                        checkReachableDone(checkReachableErr);
                        return;
                    }

                    for (idx = 0; idx < networks.length; ++idx) {
                        network = networks[idx];
                        assert.object(network, 'network');
                        assert.uuid(network.ipv4_uuid, 'network.ipv4_uuid');

                        if (vols[0].networks.indexOf(network.ipv4_uuid) !==
                            -1) {
                            foundVolNetwork = true;
                            break;
                        }
                    }

                    if (!foundVolNetwork) {
                        checkReachableErr =
                            new errors.VolumeNotReachableError('Volume ' +
                                volumeName + ' not reachable on networks ' +
                            networks.map(function getIpv4Uuid(net) {
                                assert.object(net, 'net');
                                return net.ipv4_uuid;
                            }).join(', '));
                    }

                    checkReachableDone(checkReachableErr);
                });
            },
            inputs: volumes
        }, function onAllVolsChecked(checkVolErrs) {
            var checkAllVolsErr;

            if (checkVolErrs) {
                checkAllVolsErr =
                    new errors.VolumesNotReachableError(checkVolErrs.errors());
            }

            done(checkAllVolsErr);
        });
    }


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
            rollbackRoleTags(err);
            return;
        }

        req.vm = { uuid: vmuuid };
        handleUpdateVMResponse(req, res, next, juuid);
        return;
    }
}

/*
 * Returns either true or an error indicating why snapshots are not supported
 * for this VM.
 */
function canSnapshot(vm) {

    if (['joyent', 'joyent-minimal', 'lx', 'bhyve'].indexOf(vm.brand) === -1) {
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

    /*
     * Not all the Platform Images will support bhyve snapshots. Let's fail
     * early instead of create a Job which will fail anyway
     */
    if (vm.brand === 'bhyve' &&
        vm.platform_buildstamp < MIN_BHYVE_SNAPSHOT_PLATFORM) {
        return (new errors.BrandNotSupportedError('snapshots are not '
            + 'supported for bhyve VMs unless Platform Image is "' +
            MIN_BHYVE_SNAPSHOT_PLATFORM + '" or newest'));
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
        var error = [ errors.missingParamErrorsElem('snapshot_name') ];
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
        var error = [ errors.missingParamErrorsElem('snapshot_name') ];
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
        error = [ errors.missingParamErrorsElem('server_uuid') ];
        return next(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    if (!common.validUUID(req.query.server_uuid)) {
        error = [ errors.invalidUuidErrorsElem('server_uuid') ];
        return next(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    if (!req.params.vms) {
        error = [ errors.missingParamErrorsElem('vms') ];
        return next(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    // TODO: It is broken that we don't check for deleted VMs when this happens
    vasync.forEachPipeline({
        func: function putOneVm(uuid, cb) {
            var vm = common.translateVm(req.params.vms[uuid], false);
            var oldVm = req.vms[uuid] || {};

            req.app.moray.putVm(uuid, vm, oldVm, cb);
        },
        inputs: Object.keys(req.params.vms)
    }, function putVmDone(err) {
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

    if (!common.validUUID(req.params.uuid)) {
        var error = [ errors.invalidUuidErrorsElem('uuid') ];
        return next(new errors.ValidationFailedError('Invalid Parameters',
            error));
    }

    // Parse whatever is needed before putting a raw object from vm-agent
    var vm = common.translateVm(req.params, false);

    var oldVm = req.vm || {};

    if (vm.state === 'destroyed') {
        req.app.moray.markAsDestroyed(vm,
            function vmDestroyed(err, destroyedVm) {
                if (err) {
                    return next(err);
                }

                res.send(200, vm);
                return next();
            });
    } else {
        req.app.moray.putVm(req.params.uuid, vm, oldVm,
            function onPutVm(putVmErr) {
                if (putVmErr) {
                    return next(putVmErr);
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

function _loadVms(req, res, next) {
    if (!req.query.server_uuid || !req.params.vms) {
        next();
        return;
    }

    req.app.moray.listVmsForServer(req.query.server_uuid, _serverVms);
    function _serverVms(err, vms) {
        if (err) {
            next(err);
            return;
        }

        if (vms) {
            req.vms = vms;
        }

        next();
    }
}

function _getVmSync(req, next) {
    var m = req.vm;

    // Skip calling CNAPI when a VM hasn't been allocated to a server
    if (m.server_uuid && m.server_uuid.length > 0) {
        req.app.cnapi.getVm(m.server_uuid, m.uuid, true, onGetVm);
        return;
    } else {
        onGetVm(null, null);
        return;
    }

    function onGetVm(err, vm) {
        if (err) {
            return next(err);
        }

        if (vm) {
            var newVm = common.translateVm(vm, true);
            req.app.moray.putVm(newVm.uuid, newVm, req.vm, function (putErr) {
                if (putErr) {
                    req.log.error({ err: putErr, uuid: newVm.uuid },
                        'Error storing VM on moray');
                    return next(putErr);

                }
                req.log.debug('VM object %s updated in moray', newVm.uuid);
                return next();
            });

        } else {
            req.app.moray.markAsDestroyed(req.vm, function (markErr, modVm) {
                if (markErr) {
                    return next(markErr);
                }

                req.vm = modVm;
                return next();
            });
        }
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
        listVms,
        renderVms);

    server.post({ path: '/vms', name: 'CreateVm' },
        interceptors.checkWfapi,
        preFilterNetworks,
        setPrimaryNic,
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
        mod_migrate.preloadNetworkParams,
        preFilterNetworks,
        updateVm);

    server.put({ path: '/vms/:uuid', name: 'PutVm' },
        interceptors.checkWfapi,
        _loadVm,
        putVm);

    server.put({ path: '/vms', name: 'PutVms' },
        interceptors.checkWfapi,
        _loadVms,
        putVms);

    server.get({ path: '/migrations', name: 'ListMigrations' },
        mod_migrate.listVmMigrations);

    server.get({ path: '/migrations/:uuid', name: 'GetMigration' },
        _loadVm,
        mod_migrate.loadVmMigration,
        mod_migrate.getVmMigration);

    server.get({ path: '/migrations/:uuid/watch', name: 'WatchMigration' },
        _loadVm,
        mod_migrate.loadVmMigration,
        mod_migrate.watchVmMigration);

    server.post({path: '/migrations/:uuid/store', name: 'StoreMigrationRecord'},
        // Do not call _loadVm here - this is intentionally lightweight/fast.
        mod_migrate.storeMigrationRecord);

    server.post({path: '/migrations/:uuid/progress', name: 'MigrationProgress'},
        // Do not call _loadVm here - this is intentionally lightweight/fast.
        mod_migrate.onProgress);

    server.post({path: '/migrations/:uuid/updateVmServerUuid',
        name: 'MigrationUpdateVmServerUuid'},
        // Do not call _loadVm here - this is intentionally lightweight/fast.
        _loadVm,
        mod_migrate.updateVmServerUuid,
        putVm);
    }


// --- Exports

module.exports = {
    mount: mount
};
