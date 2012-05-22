/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var assert = require('assert');
var restify = require('restify');
var ldap = require('ldapjs');
var sprintf = require('sprintf').sprintf;

var common = require('../common');

var uuid = require('node-uuid');

var VALID_MACHINE_ACTIONS = [
    'start',
    'stop',
    'reboot',
    'update'
];


function validAction(action) {
    return VALID_MACHINE_ACTIONS.indexOf(action) != -1;
}



/*
 * GET /machines/:uuid
 *
 * Returns a list of machines according the specified search filter. The valid
 * query options are: owner_uuid, brand, alias, status, and ram.
 */
function listMachines(req, res, next) {
    req.log.trace('ListMachines start');

    req.ufds.listMachines(req.params, function (err, machines) {
        if (err)
            return next(err);

        res.send(200, machines);
        return next();
    });
}



/*
 * GET /machines/:uuid
 */
function getMachine(req, res, next) {
    req.log.trace('GetMachine start');
    res.send(200, req.machine);
    return next();
}



/*
 * POST /machines/:uuid
 */
function updateMachine(req, res, next) {
    req.log.trace('UpdateMachine start');
    var method;
    var action = req.params.action;

    if (!action)
        return next(new restify.MissingParameterError('action is required'));

    if (!validAction(action))
        return next(new restify.InvalidArgumentError('%s is not a valid action',
                                             req.params.action));

    switch (action) {
        case 'start':
            method = startMachine;
            break;
        case 'stop':
            method = stopMachine;
            break;
        case 'reboot':
            method = rebootMachine;
            break;
        case 'update':
            method = changeMachine;
            break;
        default:
            next(new restify.InvalidArgumentError('%s is not a valid action',
                     req.params.action));
            break;
    }

    return method.call(this, req, res, next);
}



/*
 * Starts a machine with ?action=start
 */
function startMachine(req, res, next) {
    req.wfapi.createStartJob(req, function (err, juuid) {
        if (err)
            return next(err);

        res.header('Job-Location', '/jobs/' + juuid);
        res.send(200, req.machine);
        return next();
    });
}



/*
 * Stops a machine with ?action=stop
 */
function stopMachine(req, res, next) {
    req.wfapi.createStopJob(req, function (err, juuid) {
        if (err)
            return next(err);

        res.header('Job-Location', '/jobs/' + juuid);
        res.send(200, req.machine);
        return next();
    });
}



/*
 * Reboots a machine with ?action=reboot
 */
function rebootMachine(req, res, next) {
    req.wfapi.createRebootJob(req, function (err, juuid) {
        if (err)
            return next(err);

        res.header('Job-Location', '/jobs/' + juuid);
        res.send(200, req.machine);
        return next();
    });
}



/*
 * Changes a machine with ?action=update
 */
function changeMachine(req, res, next) {
    req.log.trace('ChangeMachine start');

    try {
      var params = common.validateUpdate(req.params);

      return req.wfapi.createUpdateJob(req, params, function (err, juuid) {
            if (err)
                return next(err);

            res.header('Job-Location', '/jobs/' + juuid);
            res.send(200, req.machine);
            return next();
      });
    } catch (e) {
        return next(e);
    }
}


/*
 * Helper function for piping wf-api and marking a machine as destroyed
 */
function markAsDestroyed(req) {
    req.ufds.markAsDestroyed(req.cache, req.machine, function (err) {
        if (err) {
            req.log.error('Error marking ' + req.machine.uuid +
                            ' as destroyed on UFDS', err);
        } else {
            req.log.info('Machine ' + req.machine.uuid +
                          ' marked as destroyed on UFDS');
        }
    });
}


/*
 * Deletes a machine
 */
function DeleteMachine(req, res, next) {
    req.log.trace('DeleteMachine start');

    req.wfapi.createDestroyJob(req, function (err, juuid) {
        if (err)
            return next(err);

        res.header('Job-Location', '/jobs/' + juuid);

        if (req.params.sync && req.params.sync == 'true') {
            req.wfapi.pipeJob(res, juuid, function (err) {
                if (err)
                    return next();

                markAsDestroyed(req);
                res.send(200, req.machine);
                return next();
            });
        } else {
            // res.header('Job-Location', '/jobs/' + juuid);
            res.send(200, req.machine);
            return next();
        }
    });
}



/*
 * Creates a new machine. This endpoint returns a task id that can be used to
 * keep track of the machine provision
 */
function createMachine(req, res, next) {
    req.log.trace('CreateMachine start');

    common.validateMachine(req.ufds, req.params, function(error) {
        if (error)
            return next(error);

        common.setDefaultValues(req.params);

        return req.wfapi.createProvisionJob(req,
        function (err, machineUuid, juuid) {
            if (err)
                  return next(err);

            req.params.state = 'provisioning';
            req.params.uuid = machineUuid;

            var machine = common.translateMachine(req.params, true);
            req.cache.set(machine.uuid, machine);

            res.header('Job-Location', '/jobs/' + juuid);
            res.send(201, machine);
            return next();
        });
    });
}



/*
 * Mounts machine actions as server routes
 */
function mount(server, before) {
    server.get({ path: '/machines', name: 'ListMachines' },
                 before, listMachines);

    server.post({ path: '/machines', name: 'CreateMachine' },
                  before, createMachine);

    server.get({ path: '/machines/:uuid', name: 'GetMachine' },
                 before, getMachine);

    server.del({ path: '/machines/:uuid', name: 'DeleteMachine' },
                 before, DeleteMachine);

    server.post({ path: '/machines/:uuid', name: 'UpdateMachine' },
                  before, updateMachine);
}


// --- Exports

module.exports = {
    mount: mount
};
