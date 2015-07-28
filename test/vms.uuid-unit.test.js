/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var assert = require('assert-plus');

var uuidUtils = require('../lib/common/uuid');

exports.test_uuid_increment = function (t) {
    t.equal(uuidUtils.incrementUUID('00000000-0000-0000-0000-000000000000'),
        '00000000-0000-0000-0000-000000000001');
    t.equal(uuidUtils.incrementUUID('00000000-0000-0000-0000-ab45f451cc02'),
        '00000000-0000-0000-0000-ab45f451cc03');
    t.equal(uuidUtils.incrementUUID('ffffffff-ffff-ffff-ffff-ffffffffffff'),
        'ffffffff-ffff-ffff-ffff-ffffffffffff');
    t.equal(uuidUtils.incrementUUID('00000000-ffff-ffff-ffff-ffffffffffff'),
        '00000001-0000-0000-0000-000000000000');
    t.equal(uuidUtils.incrementUUID('00000000-0000-ffff-ffff-ffffffffffff'),
        '00000000-0001-0000-0000-000000000000');
    t.equal(uuidUtils.incrementUUID('00000000-0000-0000-ffff-ffffffffffff'),
        '00000000-0000-0001-0000-000000000000');
    t.equal(uuidUtils.incrementUUID('00000000-0000-0000-0000-ffffffffffff'),
        '00000000-0000-0000-0001-000000000000');
    t.done();
};

exports.test_uuid_decrement = function (t) {
    t.equal(uuidUtils.decrementUUID('00000000-0000-0000-0000-000000000000'),
        '00000000-0000-0000-0000-000000000000');
    t.equal(uuidUtils.decrementUUID('00000000-0000-0000-0000-000000000001'),
        '00000000-0000-0000-0000-000000000000');
    t.equal(uuidUtils.decrementUUID('00000000-0000-0000-0000-ab45f451cc02'),
        '00000000-0000-0000-0000-ab45f451cc01');
    t.equal(uuidUtils.decrementUUID('ffffffff-ffff-ffff-ffff-ffffffffffff'),
        'ffffffff-ffff-ffff-ffff-fffffffffffe');
    t.equal(uuidUtils.decrementUUID('ffffffff-ffff-ffff-ffff-000000000000'),
        'ffffffff-ffff-ffff-fffe-ffffffffffff');
    t.equal(uuidUtils.decrementUUID('ffffffff-ffff-ffff-0000-000000000000'),
        'ffffffff-ffff-fffe-ffff-ffffffffffff');
    t.equal(uuidUtils.decrementUUID('ffffffff-ffff-0000-0000-000000000000'),
        'ffffffff-fffe-ffff-ffff-ffffffffffff');
    t.equal(uuidUtils.decrementUUID('ffffffff-0000-0000-0000-000000000000'),
        'fffffffe-ffff-ffff-ffff-ffffffffffff');
    t.done();
};
