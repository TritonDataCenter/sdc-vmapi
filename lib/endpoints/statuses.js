/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var restify = require('restify');
var assert = require('assert');

var common = require('../common');



/*
 * GET /statuses
 */
function listStatuses(req, res, next) {
    req.log.trace('ListStatuses start');

    var uuids = req.params.uuids;
    if (!uuids) {
        return next(new restify.MissingParameterError('uuids is required'));
    }

    req.cache.getVms(uuids.split(','), function (err, vms) {
        if (err)
            return next(err);

        var statuses = common.getStatuses(vms);
        res.send(statuses);
        return next();
    });
}



/*
 * Mounts job actions as server routes
 */
function mount(server, before) {
    server.get({ path: '/statuses', name: 'ListStatuses' },
        before, listStatuses);
}


// --- Exports

module.exports = {
    mount: mount
};
