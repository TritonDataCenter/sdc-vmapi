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


var util = require('./util');
var validation = require('./validation');
var vmcommon = require('./vm-common');
var predicate = require('./predicate');

var i;

var utilFunctions = Object.keys(util);
for (i = 0; i < utilFunctions.length; i++) {
    exports[utilFunctions[i]] = util[utilFunctions[i]];
}

var validationFunctions = Object.keys(validation);
for (i = 0; i < validationFunctions.length; i++) {
    exports[validationFunctions[i]] = validation[validationFunctions[i]];
}

var vmcommonFunctions = Object.keys(vmcommon);
for (i = 0; i < vmcommonFunctions.length; i++) {
    exports[vmcommonFunctions[i]] = vmcommon[vmcommonFunctions[i]];
}

var predicateFunctions = Object.keys(predicate);
for (i = 0; i < predicateFunctions.length; i++) {
    exports[predicateFunctions[i]] = predicate[predicateFunctions[i]];
}