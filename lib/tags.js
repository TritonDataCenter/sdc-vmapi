/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var restify = require('restify');
var ldap = require('ldapjs');
var assert = require('assert');



/*
 * GET /machines/:uuid/tags
 */
function listTags(req, res, next) {
    req.log.trace('ListTags start');

    req.ufds.listTags(req.machine, function (err, tags) {
        if (err)
            return next(err);

        res.send(200, tags);
        return next();
    });
}



function _getTag(req, res, next) {
    req.log.trace('_GetTag start');

    req.ufds.getTag(req.machine, req.params.key, function (err, tag) {
        if (err)
            return next(err);

        req.tag = tag;
        return next();
    });
}



/*
 * GET /machines/:uuid/tags/:key
 */
function getTag(req, res, next) {
    req.log.trace('GetTag start');

    if (!req.tag)
        return next(new restify.ResourceNotFoundError('Tag not found'));

    res.send(200, req.tag.value);
    return next();
}



/*
 * POST /machines/:uuid/tags
 */
function addTags(req, res, next) {
    req.log.trace('AddTags start');

    req.ufds.addTags(req.machine, req.params, function (err, tags) {
      if (err)
          return next(err);

      res.send(200, tags);
      return next();
    });
}



/*
 * DELETE /machines/:uuid/tags/:key
 */
function deleteTag(req, res, next) {
    req.log.trace('DeleteTag start');

    if (!req.tag)
        return next(new restify.ResourceNotFoundError('Tag not found'));

    req.ufds.deleteTag(req.tag, function (err) {
        if (err)
            return next(err);

        res.send(204);
        return next();
    });
}



/*
 * DELETE /machines/:uuid/tags
 */
function deleteTags(req, res, next) {
    req.log.trace('DeleteTags start');

    req.ufds.deleteTags(req.machine, function (err) {
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
    server.get({ path: '/machines/:uuid/tags', name: 'ListTags' },
                 before, listTags);

    server.get({ path: '/machines/:uuid/tags/:key', name: 'GetTag' },
                 before, _getTag, getTag);

    server.post({ path: '/machines/:uuid/tags', name: 'AddTags' },
                  before, _getTag, addTags);

    server.del({ path: '/machines/:uuid/tags/:key', name: 'DeleteTag' },
                  before, _getTag, deleteTag);

    server.del({ path: '/machines/:uuid/tags', name: 'DeleteTags' },
                  before, deleteTags);
}


// --- Exports

module.exports = {
    mount: mount
};