/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
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