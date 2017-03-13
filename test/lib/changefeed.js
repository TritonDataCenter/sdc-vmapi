/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');

function createNoopCfPublisher() {
    var noopChangefeedPublisher = {
        publish: function publish(item, cb) {
            assert.object(item, 'item');
            assert.func(cb, 'cb');
            cb();
        },
        mountRestifyServerRoutes:
            function mountRestifyServerRoutes(restifyServer) {
                assert.object(restifyServer, 'restifyServer');
            }
    };

    return noopChangefeedPublisher;
}

module.exports = {
    createNoopCfPublisher: createNoopCfPublisher
};