/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var restify = require('restify');
var assert = require('assert');
var common = require('../common');
var errors = require('../errors');


/*
 * This handler gets executed to load the role_tags the VM currently has
 */
function getToleTags(req, res, next) {
    req.app.moray.getRoleTags(req.vm.uuid, onRoleTags);

    function onRoleTags(err, roleTags) {
        if (err) {
            return next(err);
        }

        req.roleTags = roleTags;
        return next();
    }
}


/*
 * POST /vms/:uuid/role_tags
 */
function addRoleTags(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid }, 'AddRoleTags start');
    var error, message;
    var roleTags = req.params.role_tags;

    if (!Array.isArray(roleTags) || Object.keys(roleTags).length === 0) {
        message = 'Must be an array of UUIDs';
        error = [ errors.invalidParamErr('role_tags', message) ];
        return next(new errors.ValidationFailedError(
                    'Invalid Role Tags', error));
    }

    roleTags.forEach(function (roleTag) {
        if (!common.validUUID(roleTag)) {
            message = roleTag + ' is not a UUID';
            error = [ errors.invalidUuidErr('role_tags', message) ];
            return next(new errors.ValidationFailedError(
                        'Invalid Role Tags', error));
        }
    });

    req.app.moray.putRoleTags(req.vm.uuid, roleTags, function (err) {
        if (err) {
            return next(err);
        }

        res.send(200, roleTags);
        return next();
    });
}



/*
 * PUT /vms/:uuid/role_tags
 */
function setRoleTags(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid }, 'SetRoleTags start');
    var error, message;
    var roleTags = req.params.role_tags;
    var currentRoleTags = req.roleTags;

    if (!Array.isArray(roleTags) || Object.keys(roleTags).length === 0) {
        message = 'Must be an array of UUIDs';
        error = [ errors.invalidParamErr('role_tags', message) ];
        return next(new errors.ValidationFailedError(
                    'Invalid Role Tags', error));
    }

    roleTags.forEach(function (roleTag) {
        if (!common.validUUID(roleTag)) {
            message = roleTag + ' is not a UUID';
            error = [ errors.invalidUuidErr('role_tags', message) ];
            return next(new errors.ValidationFailedError(
                        'Invalid Role Tags', error));
        }
        if (currentRoleTags.indexOf(roleTag) === -1) {
            currentRoleTags.push(roleTag);
        }
    });

    req.app.moray.putRoleTags(req.vm.uuid, currentRoleTags, function (err) {
        if (err) {
            return next(err);
        }

        res.send(200, currentRoleTags);
        return next();
    });
}



/*
 * DELETE /vms/:uuid/role_tags/:role_tag
 */
function deleteRoleTag(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid }, 'DeleteRoleTag start');
    var roleTag = req.params.role_tag;
    var currentRoleTags = req.roleTags;
    var index = currentRoleTags.indexOf(roleTag);

    if (index === -1) {
        return next(new restify.ResourceNotFoundError('Role Tag not found'));
    }

    currentRoleTags.splice(index, 1);

    req.app.moray.putRoleTags(req.vm.uuid, currentRoleTags, function (err) {
        if (err) {
            return next(err);
        }

        res.send(200, currentRoleTags);
        return next();
    });
}



/*
 * DELETE /vms/:uuid/role_tags
 */
function deleteAllRoleTags(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid }, 'DeleteAllRoleTags start');

    req.app.moray.delRoleTags(req.vm.uuid, function (err) {
        if (err) {
            return next(err);
        }

        res.send(200);
        return next();
    });
}



/*
 * Mounts role_tags actions as server routes
 */
function mount(server, before) {
    server.post({ path: '/vms/:uuid/role_tags', name: 'AddRoleTags' },
                  before, getToleTags, addRoleTags);

    server.put({ path: '/vms/:uuid/role_tags', name: 'SetRoleTags' },
                  before, setRoleTags);

    server.del({ path: '/vms/:uuid/role_tags/:role_tag',
                  name: 'DeleteRoleTag' },
                  before, getToleTags, deleteRoleTag);

    server.del({ path: '/vms/:uuid/role_tags', name: 'DeleteAllRoleTags' },
                  before, deleteAllRoleTags);
}


// --- Exports

module.exports = {
    mount: mount
};
