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
 * Returns true if the LDAP filter string "ldapFilterString" represents an LDAP
 * filter that filters on the field with name "fieldName".
 */
function ldapFilterFiltersOn(fieldName, ldapFilterString) {
    var fieldPresentRegexp;

    assert.string(fieldName, 'fieldName');
    assert.optionalString(ldapFilterString, 'ldapFilterString');

    if (ldapFilterString === undefined) {
        return false;
    }

    fieldPresentRegexp = new RegExp('\\(' + fieldName + '=');

    return fieldPresentRegexp.test(ldapFilterString);
}

module.exports = {
    ldapFilterFiltersOn: ldapFilterFiltersOn
};