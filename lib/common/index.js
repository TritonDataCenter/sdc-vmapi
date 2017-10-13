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

var assert = require('assert-plus');

function mixinModule(modulePath) {
    assert.string(modulePath, 'modulePath must be a string');

    var i;
    var module = require(modulePath);
    var moduleExports = Object.keys(module);

    for (i = 0; i < moduleExports.length; i++) {
        assert.equal(exports[moduleExports[i]], undefined, moduleExports[i] +
            ' from module ' + modulePath +
            ' must not already exist in target module');
        exports[moduleExports[i]] = module[moduleExports[i]];
    }
}

mixinModule('./ldap-filter');
mixinModule('./marker');
mixinModule('./predicate');
mixinModule('./util');
mixinModule('./validation');
mixinModule('./vm-common');
