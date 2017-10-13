/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');

var DATA_VERSION = 1;

module.exports = {
    DATA_VERSION: DATA_VERSION,
    migrateRecord: function migrateRecord(record) {
        assert.object(record, 'record');
        record.value.bar = 'foo';
        record.value.data_version = DATA_VERSION;
        return record;
    }
};