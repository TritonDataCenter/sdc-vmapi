/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

 /*
  * This module contains functions that can be used to validate
  * sort criterion of the form 'property.order' that are passed as
  * query string parameters to VMAPI's endpoints. For instance, in:
  *
  * GET /vms?sort=create_timestamp.ASC
  *
  * the sort criteria is the string 'create_timestamp.ASC'.
  */

var assert = require('assert-plus');

var VALID_SORT_KEYS = [
    'uuid',
    'owner_uuid',
    'image_uuid',
    'billing_id',
    'server_uuid',
    'package_name',
    'package_version',
    'tags',
    'brand',
    'state',
    'alias',
    'max_physical_memory',
    'create_timestamp',
    'docker'
];
exports.VALID_SORT_KEYS = VALID_SORT_KEYS;

var VALID_SORT_ORDERS = ['ASC', 'DESC'];
exports.VALID_SORT_ORDERS = VALID_SORT_ORDERS;

function isValidSortCriteria(sortCriteriaString) {
    assert.string(sortCriteriaString, 'sortCriteriaString must be a string');

    // No sort criteria is considered a valid sort criteria
    if (sortCriteriaString === '')
        return true;

    var sortCriteriaComponents = sortCriteriaString.split('.');
    var sortKey = sortCriteriaComponents[0];
    var sortOrder = sortCriteriaComponents[1];

    return VALID_SORT_KEYS.indexOf(sortKey) > -1 &&
        (sortOrder === undefined || VALID_SORT_ORDERS.indexOf(sortOrder) > -1);
}
exports.isValidSortCriteria = isValidSortCriteria;
