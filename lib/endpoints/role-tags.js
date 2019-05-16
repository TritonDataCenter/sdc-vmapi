/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * A brief overview of this source file: what is its purpose.
 */

var restify = require('restify');
var assert = require('assert');
var common = require('../common');
var errors = require('../errors');
var interceptors = require('../interceptors');


/*
 * This handler gets executed to load the role_tags the VM currently has
 */
function getVmRoleTags(req, res, next) {
    req.app.moray.getVmRoleTags(req.vm.uuid, onRoleTags);

    function onRoleTags(err, roleTags) {
        if (err) {
            return next(err);
        }

        req.roleTags = roleTags;
        return next();
    }
}


/*
 * PUT /vms/:uuid/role_tags
 */
function addRoleTags(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid }, 'AddRoleTags start');
    var error, message;
    var roleTags = req.params.role_tags;
    var currentRoleTags = req.roleTags;

    if (!Array.isArray(roleTags) || Object.keys(roleTags).length === 0) {
        message = 'Must be an array of UUIDs';
        error = [ errors.invalidParamErrorsElem('role_tags', message) ];
        return next(new errors.ValidationFailedError(
                    'Invalid Role Tags', error));
    }

    roleTags.forEach(function (roleTag) {
        if (!common.validUUID(roleTag)) {
            message = roleTag + ' is not a UUID';
            error = [ errors.invalidUuidErrorsElem('role_tags', message) ];
            return next(new errors.ValidationFailedError(
                        'Invalid Role Tags', error));
        }
        if (currentRoleTags.indexOf(roleTag) === -1) {
            currentRoleTags.push(roleTag);
        }
    });

    req.app.moray.putVmRoleTags(req.vm.uuid, currentRoleTags, function (err) {
        if (err) {
            return next(err);
        }

        res.send(200, currentRoleTags);
        return next();
    });
}


/*
 * POST /vms/:uuid/role_tags
 */
function setRoleTags(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid }, 'SetRoleTags start');
    var error, message;
    var roleTags = req.params.role_tags;

    if (!Array.isArray(roleTags) || Object.keys(roleTags).length === 0) {
        message = 'Must be an array of UUIDs';
        error = [ errors.invalidParamErrorsElem('role_tags', message) ];
        return next(new errors.ValidationFailedError(
                    'Invalid Role Tags', error));
    }

    roleTags.forEach(function (roleTag) {
        if (!common.validUUID(roleTag)) {
            message = roleTag + ' is not a UUID';
            error = [ errors.invalidUuidErrorsElem('role_tags', message) ];
            return next(new errors.ValidationFailedError(
                        'Invalid Role Tags', error));
        }
    });

    req.app.moray.putVmRoleTags(req.vm.uuid, roleTags, function (err) {
        if (err) {
            return next(err);
        }

        res.send(200, roleTags);
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

    req.app.moray.putVmRoleTags(req.vm.uuid, currentRoleTags, function (err) {
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

    req.app.moray.delVmRoleTags(req.vm.uuid, function (err) {
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
        interceptors.checkWfapi,
        interceptors.loadVm,
        getVmRoleTags,
        addRoleTags);

    server.put({ path: '/vms/:uuid/role_tags', name: 'SetRoleTags' },
        interceptors.checkWfapi,
        interceptors.loadVm,
        setRoleTags);

    server.del({ path: '/vms/:uuid/role_tags/:role_tag',
        name: 'DeleteRoleTag' },
        interceptors.checkWfapi,
        interceptors.loadVm,
        getVmRoleTags,
        deleteRoleTag);

    server.del({ path: '/vms/:uuid/role_tags', name: 'DeleteAllRoleTags' },
        interceptors.checkWfapi,
        interceptors.loadVm,
        deleteAllRoleTags);
}


// --- Exports

module.exports = {
    mount: mount
};
