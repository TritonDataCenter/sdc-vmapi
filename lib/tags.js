/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var restify = require('restify');
var ldap = require('ldapjs');
var assert = require('assert');



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

    if (Object.keys(tags).length == 0)
      res.send(204);
    else
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



function getTag(req, res, next) {
  req.log.trace('GetTag start');

  if (!req.tag)
    return next(new restify.ResourceNotFoundError('Tag not found'));

  var tag = {};
  tag[req.tag.key] = req.tag.value;
  res.send(200, tag);
}



function setTag(req, res, next) {
  req.log.trace('GetTag start');

  var object, operation;
  var key = req.params.key;
  var value = req.body;
  var baseDn = "tagkey=" + req.params.key + ", " + req.machine.dn;

  if (!value || value == "")
    return next(new restify.InvalidArgumentError('Tag value must be provided'));

  var tag = {
    key: key,
    value: value
  };

  if (req.tag == undefined) {
    operation = req.ufds.add;
    object = tag;
    object.objectclass = "tag";
  } else {
    operation = req.ufds.modify;
    object = {
      type: 'replace',
      modification: tag
    };
  }

  operation.call(req.ufds, baseDn, object, function(err) {
    if (err)
      return next(err);

    var tag = {};
    tag[key] = value;
    res.send(200, tag);
  });
}



function deleteTag(req, res, next) {
  req.log.trace('DeleteTag start');

  if (!req.tag)
    return next(new restify.ResourceNotFoundError('Tag not found'));

    console.log("waht");

  var baseDn = req.tag.dn;

  req.ufds.del(baseDn, function(err, items) {
    if (err)
      return next(err);

    res.send(200);
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

  server.put({ path: '/machines/:uuid/tags/:key', name: 'SetTag' },
                before, _getTag, setTag);

  server.del({ path: '/machines/:uuid/tags/:key', name: 'DeleteTag' },
                before, _getTag, deleteTag);
}


///--- Exports

module.exports = {
    mount: mount
};