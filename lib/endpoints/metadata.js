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

var restify = require('restify');
var assert = require('assert');
var common = require('../common');
var errors = require('../errors');

var METADATA_TYPES = [
    'customer_metadata',
    'internal_metadata',
    'tags'
];


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
function setMetadataType(req, res, next) {
    req.log.trace('SetMetadataType start');

    var metadata = req.params.metadata;
    if (METADATA_TYPES.indexOf(metadata) === -1) {
        return next(new restify.ResourceNotFoundError('Route does not exist'));
    }

    req.metadata = metadata;
    return next();
}


/*
 * GET /vms/:uuid/:metadata
 */
function listMetadata(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid },
        'List ' + req.metadata + ' start');

    res.send(200, req.vm[req.metadata]);
    return next();
}



/*
 * GET /vms/:uuid/:metadata/:key
 */
function getMetadata(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid },
        'Get ' + req.metadata + ' start');

    var metadata = req.vm[req.metadata];

    if (!metadata[req.params.key]) {
        return next(new restify.ResourceNotFoundError(
                    'Metadata key not found'));
    }

    res.send(200, metadata[req.params.key]);
    return next();
}



/*
 * POST /vms/:uuid/:metadata
 */
function addMetadata(req, res, next) {
    req.log.trace({ vm_uuid: req.params.uuid },
        'Add ' + req.metadata + ' start');
    var params;

    try {
        params = common.addMetadata(req.metadata, req.body);
        common.validMetadata(req.metadata, params['set_' + req.metadata], true);
    } catch (e) {
        var error = (e.body && e.body.errors) ? [ e.body.errors[0] ] :
            [ errors.invalidParamErr(req.metadata) ];
        return next(new errors.ValidationFailedError(
                    'Invalid Metadata parameters', error));
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
 * PUT /vms/:uuid/:metadata
 */
function setMetadata(req, res, next) {
    var metaName = req.metadata;
    var params;

    req.log.trace({ vm_uuid: req.params.uuid }, 'Set ' + metaName + ' start');

    try {
        params = common.setMetadata(req.vm, metaName, req.body);
        common.validMetadata(metaName, params['set_' + metaName], true);

        var deletions = params['remove_' + metaName] || [];
        deletions.forEach(function (key) {
            common.validDeleteMetadata(metaName, key);
        });
    } catch (e) {
        var error = (e.body && e.body.errors) ? [ e.body.errors[0] ] :
            [ errors.invalidParamErr(metaName) ];
        return next(new errors.ValidationFailedError(
                    'Invalid Metadata parameters', error));
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
 * DELETE /vms/:uuid/:metadata/:key
 */
function deleteMetadata(req, res, next) {
    var metaName = req.metadata;
    var metaKey  = req.params.key;
    var metadata = req.vm[metaName];

    req.log.trace({ vm_uuid: req.params.uuid },
        'Delete ' + metaName + ' start');

    if (!metadata[metaKey]) {
        /*JSSTYLED*/
        return next(new restify.ResourceNotFoundError('Metadata key not found'));
    }

    try {
        common.validDeleteMetadata(metaName, metaKey);
    } catch (e) {
        var error = (e.body && e.body.errors) ? [ e.body.errors[0] ] :
            [ errors.invalidParamErr(metaName) ];
        return next(new errors.ValidationFailedError(
                    'Invalid Metadata parameters', error));
    }

    var params = common.deleteMetadata(metaName, metaKey);
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
 * DELETE /vms/:uuid/:metadata
 */
function deleteAllMetadata(req, res, next) {
    var metaName = req.metadata;
    var metadata = req.vm[metaName];

    req.log.trace({ vm_uuid: req.params.uuid },
        'Delete all' + metaName + ' start');

    try {
        common.validDeleteAllMetadata(metaName, metadata);
    } catch (e) {
        var error = (e.body && e.body.errors) ? [ e.body.errors[0] ] :
            [ errors.invalidParamErr(metaName) ];
        return next(new errors.ValidationFailedError(
                    'Invalid Metadata parameters', error));
    }

    var params = common.deleteAllMetadata(req.vm, metaName);
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
function mount(server, before) {
    server.get({ path: '/vms/:uuid/:metadata', name: 'ListMetadata' },
                 before, setMetadataType, listMetadata);

    server.get({ path: '/vms/:uuid/:metadata/:key', name: 'GetMetadata' },
                 before, setMetadataType, getMetadata);

    server.post({ path: '/vms/:uuid/:metadata', name: 'AddMetadata' },
                  before, setMetadataType, addMetadata);

    server.put({ path: '/vms/:uuid/:metadata', name: 'SetMetadata' },
                  before, setMetadataType, setMetadata);

    server.del({ path: '/vms/:uuid/:metadata/:key', name: 'DeleteMetadata' },
                  before, setMetadataType, deleteMetadata);

    server.del({ path: '/vms/:uuid/:metadata', name: 'DeleteAllMetadata' },
                  before, setMetadataType, deleteAllMetadata);
}


// --- Exports

module.exports = {
    mount: mount
};
