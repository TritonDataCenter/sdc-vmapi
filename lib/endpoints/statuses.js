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



/*
 * GET /statuses
 */
function listStatuses(req, res, next) {
    req.log.trace('ListStatuses start');

    var uuids = req.params.uuids;
    if (!uuids) {
        return next(new restify.MissingParameterError('uuids is required'));
    }

    return req.app.moray.getVms(uuids.split(','), function (err, vms) {
        if (err) {
            return next(err);
        }

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
