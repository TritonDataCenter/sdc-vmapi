/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var restify = require('restify');
var ldap = require('ldapjs');
var assert = require('assert');

var METADATA_TYPES = [
    'customer_metadata',
    'internal_metadata',
    'tags'
]


/*
 * The idea is that customer_metadata, internal_metadata and tags are exactly
 * the same in how they are accessed and modified. Here we reuse the same
 * actions for each one of those and set the appropriate metadata key in the
 * before chain
 */
function setMetadataType(req, res, next) {
    req.log.trace('SetMetadataType start');

    var metadata = req.params.metadata;
    if (METADATA_TYPES.indexOf(metadata) == -1)
        return next(new restify.ResourceNotFoundError('Route does not exist'));

    req.metadata = metadata;
    return next();
}


/*
 * GET /machines/:uuid/:metadata
 */
function listMetadata(req, res, next) {
    req.log.trace('List ' + req.metadata + ' start');

    res.send(200, req.machine[req.metadata]);
    return next();
}



/*
 * GET /machines/:uuid/:metadata/:key
 */
function getMetadata(req, res, next) {
    req.log.trace('Get ' + req.metadata + ' start');

    var metadata = req.machine[req.metadata];

    if (!metadata[req.params.key]) {
        return next(
            new restify.ResourceNotFoundError('Metadata key not found'));
    }

    res.send(200, metadata[req.params.key]);
    return next();
}



/*
 * POST /machines/:uuid/:metadata
 */
function addMetadata(req, res, next) {
    req.log.trace('Add ' + req.metadata + ' start');

    req.ufds.addMetadata(req.machine, req.metadata, req.params,
        function (err, metadata) {
      if (err)
          return next(err);

      res.send(200, metadata);
      return next();
    });
}



/*
 * DELETE /machines/:uuid/:metadata/:key
 */
function deleteMetadata(req, res, next) {
    req.log.trace('Delete ' + req.metadata + ' start');

    var metadata = req.machine[req.metadata];

    if (!metadata[req.params.key]) {
        return next(
            new restify.ResourceNotFoundError('Metadata key not found'));
    }

    return req.ufds.deleteMetadata(req.machine, req.metadata, req.params.key,
        function (err) {
        if (err)
            return next(err);

        res.send(204);
        return next();
    });
}



/*
 * DELETE /machines/:uuid/:metadata
 */
function deleteMetadata(req, res, next) {
    req.log.trace('Delete all ' + req.metadata + ' start');

    req.ufds.deleteMetadata(req.machine, req.metadata, function (err) {
        if (err)
            return next(err);

        res.send(204);
        return next();
    });
}



/*
 * Mounts machine actions as server routes
 */
function mount(server, before) {
    server.get({ path: '/machines/:uuid/:metadata', name: 'ListMetadata' },
                 before, setMetadataType, listMetadata);

    server.get({ path: '/machines/:uuid/:metadata/:key', name: 'GetMetadata' },
                 before, setMetadataType, getMetadata);

    server.post({ path: '/machines/:uuid/:metadata', name: 'AddMetadata' },
                  before, setMetadataType, addMetadata);

    server.del({ path: '/machines/:uuid/:metadata/:key', name: 'DeleteMetadata' },
                  before, setMetadataType, deleteMetadata);

    server.del({ path: '/machines/:uuid/:metadata', name: 'DeleteMetadata' },
                  before, setMetadataType, deleteMetadata);
}


// --- Exports

module.exports = {
    mount: mount
};
