/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');

/*
 * Creates an returns an instance of a mocked changefeed publisher that doesn't
 * publish changes. Not passing any changefeed publisher instance to the Moray
 * persistence layer is not an option, so a "no-op" publisher is useful when
 * writing tests or programs for which publishing changes to any changefeed
 * listener is not relevant (and could actually introduce problems).
 */
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