/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var util = require('./util');
var validation = require('./validation');
var vmcommon = require('./vm-common');
var errors = require('./errors');

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

var errorFunctions = Object.keys(errors);
for (i = 0; i < errorFunctions.length; i++) {
    exports[errorFunctions[i]] = errors[errorFunctions[i]];
}