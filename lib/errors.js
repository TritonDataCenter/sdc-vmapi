/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var assert = require('assert-plus');
var restify = require('restify');
var util = require('util');



/*
 * This erros is produced when trying to delete a VM that hasn't been
 * provisioned yet
 */
function UnallocatedVMError(message) {
    assert.string(message, 'message');

    restify.RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: message,
        body: {
            code: this.constructor.restCode,
            message: message
        }
    });
}

util.inherits(UnallocatedVMError, restify.RestError);
UnallocatedVMError.prototype.name = 'UnallocatedVMError';
UnallocatedVMError.restCode = 'UnallocatedVM';
UnallocatedVMError.statusCode = 409;



/*
 * Base function for validation errors
 */
function ValidationFailedError(message, errors) {
    assert.string(message, 'message');
    assert.arrayOfObject(errors, 'errors');

    restify.RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: message,
        body: {
            code: this.constructor.restCode,
            message: message,
            errors: errors
        }
    });
}

util.inherits(ValidationFailedError, restify.RestError);
ValidationFailedError.prototype.name = 'ValidationFailedError';
ValidationFailedError.restCode = 'ValidationFailed';
ValidationFailedError.statusCode = 409;


/*
 * General error response for invalid UUIDs
 */
exports.invalidUuidErr = function (field, message) {
    return {
        field: field || 'uuid',
        code: 'Invalid',
        message: message || 'Invalid UUID'
    };
};



/*
 * General error response for invalid parameters
 */
exports.invalidParamErr = function (field, message) {
    assert.string(field, 'field');

    return {
        field: field,
        code: 'Invalid',
        message: message || 'Invalid parameter'
    };
};



/*
 * General error response for duplicate parameters
 */
exports.duplicateParamErr = function (field, message) {
    assert.string(field, 'field');

    return {
        field: field,
        code: 'Duplicate',
        message: message || 'Already exists'
    };
};



/*
 * General error response for missing request parameters
 */
exports.missingParamErr = function (field, message) {
    assert.string(field, 'field');

    var obj = {
        field: field,
        code: 'MissingParameter'
    };

    if (message) {
        obj.message = message;
    }

    return obj;
};


exports.UnallocatedVMError = UnallocatedVMError;
exports.ValidationFailedError = ValidationFailedError;
