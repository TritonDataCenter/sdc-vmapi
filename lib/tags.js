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

  var baseDn = req.machine.dn;

  var options = {
    scope: "sub",
    filter: "(objectclass=tag)"
  };

  req.ufds.search(baseDn, options, function(err, items) {
    if (err)
      return next(err);

    var tags = {};

    for (var i = 0; i < items.length; i++)
      tags[items[i].key] = items[i].value;

    res.send(200, tags);
    return next();
  });
}



function _getTag(req, res, next) {
  var baseDn = req.machine.dn;
  var key = req.params.key

  var options = {
    scope: "sub",
    filter: "(&(objectclass=tag)(key=" + key + "))"
  };

  req.ufds.search(baseDn, options, function(err, items) {
    if (err)
      return next(err);

    if (items.length != 0)
      req.tag = items[0];

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

  var tags = {};

  Object.keys(req.params).forEach(function (key) {
    if (key != "uuid")
      tags[key] = req.params[key];
  });

  var keys = Object.keys(tags);
  var added = 0;

  if (!keys.length)
    return next(new restify.InvalidArgumentError('At least one tag must be provided'));


  for (var i = 0; i < keys.length; i++) {
    var baseDn = "tagkey=" + keys[i] + ", " + req.machine.dn;

    var tag = {
      key: keys[i],
      value: tags[keys[i]],
      objectclass: "tag"
    };

    req.ufds.add(baseDn, tag, function(err) {
      if (err)
        return next(err);

      added++;

      if (added == keys.length) {
        res.send(200, tags);
        return next();
      }
    });
  }

}



/*
 * DELETE /machines/:uuid/tags/:key
 */
function deleteTag(req, res, next) {
  req.log.trace('DeleteTag start');

  if (!req.tag)
    return next(new restify.ResourceNotFoundError('Tag not found'));

  var baseDn = req.tag.dn;

  req.ufds.del(baseDn, function(err) {
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

  var baseDn = req.machine.dn;

  var options = {
    scope: "sub",
    filter: "(objectclass=tag)"
  };

  req.ufds.search(baseDn, options, function(err, items) {
    if (err)
      return next(err);

    if (!items.length) {
      res.send(204);
      return next();
    }

    var deleted = 0;

    for (var i = 0; i < items.length; i++) {
      var tag = items[i];

      req.ufds.del(tag.dn, function(err) {
        if (err)
          return next(err);

        deleted++;

        if (deleted == items.length) {
          res.send(204);
          return next();
        }
      });
    }
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


///--- Exports

module.exports = {
    mount: mount
};