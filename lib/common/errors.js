/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var restify = require('restify');
var util = require('util');

function UnallocatedVMError(message) {
    restify.RestError.call(this,
        409,
        'UnallocatedVMError',
        message,
        UnallocatedVMError);

    this.name = 'UnallocatedVMError';
}

util.inherits(UnallocatedVMError, restify.RestError);


exports.UnallocatedVMError = UnallocatedVMError;
