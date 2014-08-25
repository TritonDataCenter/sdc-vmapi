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
var restify = require('restify');
var util = require('util');



/*
 * This error is produced when trying to delete a VM that hasn't been
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
 * This error is produced when processing a heartbeat CNAPI returns 404. This
 * happens when a VM has been detected as destroyed and by the time the
 * heartbeater asks CNAPI about it it's already gone
 */
function VmGoneError(message) {
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

util.inherits(VmGoneError, restify.ResourceNotFoundError);
VmGoneError.prototype.name = 'VmGoneError';
VmGoneError.restCode = 'VmGone';
VmGoneError.statusCode = 404;



/*
 * This error is produced when trying to call an action on a brand that doesn't
 * support it
 */
function BrandNotSupportedError(message) {
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

util.inherits(BrandNotSupportedError, restify.RestError);
BrandNotSupportedError.prototype.name = 'BrandNotSupportedError';
BrandNotSupportedError.restCode = 'BrandNotSupported';
BrandNotSupportedError.statusCode = 409;



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
exports.BrandNotSupportedError = BrandNotSupportedError;
exports.VmGoneError = VmGoneError;
