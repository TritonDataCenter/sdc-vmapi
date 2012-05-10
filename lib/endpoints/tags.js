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

    res.send(200, req.machine.tags);
    return next();
}



/*
 * GET /machines/:uuid/tags/:key
 */
function getTag(req, res, next) {
    req.log.trace('GetTag start');

    var tags = req.machine.tags;

    if (!tags[req.params.key])
        return next(new restify.ResourceNotFoundError('Tag not found'));

    res.send(200, tags[req.params.key]);
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

    var tags = req.machine.tags;

    if (!tags[req.params.key])
        return next(new restify.ResourceNotFoundError('Tag not found'));

    return req.ufds.deleteTag(req.machine, req.params.key, function (err) {
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
                 before, getTag);

    server.post({ path: '/machines/:uuid/tags', name: 'AddTags' },
                  before, addTags);

    server.del({ path: '/machines/:uuid/tags/:key', name: 'DeleteTag' },
                  before, deleteTag);

    server.del({ path: '/machines/:uuid/tags', name: 'DeleteTags' },
                  before, deleteTags);
}


// --- Exports

module.exports = {
    mount: mount
};
