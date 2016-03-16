/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

/*
 * Handle '/vms/:vmUuid/:metaType/...' endpoints. I.e. the shared set of
 * endpoints for managing a VM's "customer_metadata", "internal_metadata",
 * and "tags".
 */

var assert = require('assert-plus');
var format = require('util').format;
var restify = require('restify');

var common = require('../common');
var errors = require('../errors');
var interceptors = require('../interceptors');


// ---- globals

var META_TYPES = [
    'customer_metadata',
    'internal_metadata',
    'tags'
];

var META_HUMAN_NAME_FROM_META_TYPE = {
    customer_metadata: 'metadatum',
    internal_metadata: 'internal metadatum',
    tags: 'tag'
};


// ---- internal support functions

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


/*
 * The idea is that customer_metadata, internal_metadata and tags are exactly
 * the same in how they are accessed and modified. Here we reuse the same
 * actions for each one of those and set the appropriate metadata key in the
 * before chain
 */
function reqMetaType(req, res, next) {
    var metaType = req.params.metaType;
    if (META_TYPES.indexOf(metaType) === -1) {
        return next(new restify.ResourceNotFoundError('Route does not exist'));
    }

    req.metaType = metaType;
    return next();
}


// ---- endpoint handlers

/*
 * GET /vms/:uuid/:metaType
 */
function listMetadata(req, res, next) {
    res.send(200, req.vm[req.metaType]);
    return next();
}



/*
 * GET /vms/:uuid/:metaType/:key
 */
function getMetadata(req, res, next) {
    var metaKey = req.params.key;
    var metaHumanName = META_HUMAN_NAME_FROM_META_TYPE[req.metaType];
    assert.string(metaHumanName, 'metaHumanName');

    var metadata = req.vm[req.metaType];
    if (!metadata || !metadata.hasOwnProperty(metaKey)) {
        return next(new restify.ResourceNotFoundError(
            format('%s "%s" not found', metaHumanName, metaKey)));
    }

    res.send(200, metadata[metaKey]);
    return next();
}



/*
 * POST /vms/:uuid/:metaType
 */
function addMetadata(req, res, next) {
    var metaType = req.metaType;
    var metaHumanName = META_HUMAN_NAME_FROM_META_TYPE[metaType];
    assert.string(metaHumanName, 'metaHumanName');
    var params;

    try {
        params = common.addMetadata(metaType, req.body);
        common.validMetadata(metaType, params['set_' + metaType]);
    } catch (e) {
        var error = (e.body && e.body.errors) ? [ e.body.errors[0] ] :
            [ errors.invalidParamErr(metaType) ];
        return next(new errors.ValidationFailedError(
            'Invalid ' + metaHumanName + ' parameters', error));
    }

    params.subtask = 'metadata';
    setContext(req, params);

    return req.app.wfapi.createUpdateJob(req, common.clone(params),
        function (err, juuid) {
          if (err) {
              return next(err);
          }

          res.send(202, { vm_uuid: req.vm.uuid, job_uuid: juuid });
          return next();
    });
}



/*
 * PUT /vms/:uuid/:metaType
 */
function setMetadata(req, res, next) {
    var metaType = req.metaType;
    var metaHumanName = META_HUMAN_NAME_FROM_META_TYPE[metaType];
    assert.string(metaHumanName, 'metaHumanName');
    var params;

    try {
        params = common.setMetadata(req.vm, metaType, req.body);
        common.validMetadata(metaType, params['set_' + metaType]);

        var deletions = params['remove_' + metaType] || [];
        deletions.forEach(function (key) {
            common.validDeleteMetadata(metaType, key);
        });
    } catch (e) {
        var error = (e.body && e.body.errors) ? [ e.body.errors[0] ] :
            [ errors.invalidParamErr(metaType) ];
        return next(new errors.ValidationFailedError(
            'Invalid ' + metaHumanName + ' parameters', error));
    }

    params.subtask = 'metadata';
    setContext(req, params);

    return req.app.wfapi.createUpdateJob(req, common.clone(params),
        function (err, juuid) {
          if (err) {
              return next(err);
          }

          res.send(202, { vm_uuid: req.vm.uuid, job_uuid: juuid });
          return next();
    });
}



/*
 * DeleteMetadata (DELETE /vms/:uuid/:metaType/:key)
 */
function deleteMetadata(req, res, next) {
    var metaType = req.metaType;
    var metaHumanName = META_HUMAN_NAME_FROM_META_TYPE[metaType];
    assert.string(metaHumanName, 'metaHumanName');
    var metaKey = req.params.key;
    var metadata = req.vm[metaType];

    if (!metadata || !metadata.hasOwnProperty(metaKey)) {
        return next(new restify.ResourceNotFoundError(
            format('%s "%s" not found', metaHumanName, metaKey)));
    }

    try {
        common.validDeleteMetadata(metaType, metaKey);
    } catch (e) {
        var error = (e.body && e.body.errors) ? [ e.body.errors[0] ] :
            [ errors.invalidParamErr(metaType) ];
        return next(new errors.ValidationFailedError(
            'Invalid ' + metaHumanName + ' parameters', error));
    }

    var params = common.deleteMetadata(metaType, metaKey);
    params.subtask = 'metadata';

    setContext(req, params);

    return req.app.wfapi.createUpdateJob(req, common.clone(params),
      function (err, juuid) {
        if (err) {
            return next(err);
        }

        res.send(202, { vm_uuid: req.vm.uuid, job_uuid: juuid });
        return next();
    });
}



/*
 * DELETE /vms/:uuid/:metaType
 */
function deleteAllMetadata(req, res, next) {
    var metaType = req.metaType;
    var metaHumanName = META_HUMAN_NAME_FROM_META_TYPE[metaType];
    assert.string(metaHumanName, 'metaHumanName');
    var metadata = req.vm[metaType];

    try {
        common.validDeleteAllMetadata(metaType, metadata);
    } catch (e) {
        var error = (e.body && e.body.errors) ? [ e.body.errors[0] ] :
            [ errors.invalidParamErr(metaType) ];
        return next(new errors.ValidationFailedError(
            'Invalid ' + metaHumanName + ' parameters', error));
    }

    var params = common.deleteAllMetadata(req.vm, metaType);
    params.subtask = 'metadata';

    setContext(req, params);

    return req.app.wfapi.createUpdateJob(req, common.clone(params),
      function (err, juuid) {
        if (err) {
            return next(err);
        }

        res.send(202, { vm_uuid: req.vm.uuid, job_uuid: juuid });
        return next();
    });
}



/*
 * Mounts metadata actions as server routes
 */
function mount(server) {
    server.get({ path: '/vms/:uuid/:metaType', name: 'ListMetadata' },
        interceptors.loadVm,
        reqMetaType,
        listMetadata);

    server.get({ path: '/vms/:uuid/:metaType/:key', name: 'GetMetadata' },
        interceptors.loadVm,
        reqMetaType,
        getMetadata);

    server.post({ path: '/vms/:uuid/:metaType', name: 'AddMetadata' },
        interceptors.checkWfapi,
        interceptors.loadVm,
        reqMetaType,
        addMetadata);

    server.put({ path: '/vms/:uuid/:metaType', name: 'SetMetadata' },
        interceptors.checkWfapi,
        interceptors.loadVm,
        reqMetaType,
        setMetadata);

    server.del({ path: '/vms/:uuid/:metaType/:key', name: 'DeleteMetadata' },
        interceptors.checkWfapi,
        interceptors.loadVm,
        reqMetaType,
        deleteMetadata);

    server.del({ path: '/vms/:uuid/:metaType', name: 'DeleteAllMetadata' },
        interceptors.checkWfapi,
        interceptors.loadVm,
        reqMetaType,
        deleteAllMetadata);
}


// --- Exports

module.exports = {
    mount: mount
};
