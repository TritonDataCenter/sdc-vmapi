/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * This data migration is used to allow searching on the internal_metadata
 * property of VM objects. It reads the content of the internal_metadata
 * property of each VM object, and writes it to an indexed
 * "internal_metadata_search_array" property in a way that is searchable.
 */

var assert = require('assert-plus');
var common = require('../../../common');

var DATA_VERSION = 1;

function migrateRecord(record, options) {
    var log;
    var parsedInternalMetadata;
    var recordValue;

    assert.object(record, 'record');
    assert.object(record.value, 'record.value');
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');

    log = options.log;
    recordValue = record.value;

    if (recordValue.data_version !== undefined) {
        return;
    }

    if (recordValue.internal_metadata !== null &&
        recordValue.internal_metadata !== undefined) {
        assert.string(record.value.internal_metadata,
            'record.value.internal_metadata');

        parsedInternalMetadata = JSON.parse(recordValue.internal_metadata);
    }

    recordValue.internal_metadata_search_array =
        common.internalMetadataToSearchArray(parsedInternalMetadata, {
            log: log
        });

    recordValue.data_version = DATA_VERSION;

    return record;
}

module.exports = {
    migrateRecord: migrateRecord,
    DATA_VERSION: DATA_VERSION
};