/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Collection of Error Objects that are used throughout VMAPI.
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
 *  Return this error when we try to do something that only makes sense on a
 *  running container.
 */
function VmNotRunningError() {
    restify.RestError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: 'VM not running',
        body: {
            code: this.constructor.restCode
        }
    });
}

util.inherits(VmNotRunningError, restify.ResourceNotFoundError);
VmNotRunningError.prototype.name = 'VmNotRunningError';
VmNotRunningError.restCode = 'VmNotRunning';
VmNotRunningError.statusCode = 409;



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


exports.insufficientCapacityErr = function (field, message) {
    assert.string(field, 'field');
    return {
        field: field,
        code: 'InsufficientCapacity',
        message: message || 'Invalid Capacity'
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

exports.conflictingParamsErr = function conflictingParamsErr(fields, message) {
    assert.arrayOfString(fields, 'fields');

    var obj = {
        fields: fields,
        code: 'ConflictingParameters'
    };

    if (message) {
        obj.message = message;
    }

    return obj;
};


exports.wfapiWrap = function (opts) {
    var error = opts.error;

    var erropts = {
        restCode: opts.restCode || error.restCode,
        statusCode: opts.statusCode || error.statusCode,
        message: opts.message,
        constructorOpt: _WorkflowError
    };

    function _WorkflowError() {
        restify.RestError.call(this, erropts);
        this.name = error.name;
    }
    _WorkflowError.restCode = erropts.restCode;
    _WorkflowError.statusCode = erropts.statusCode;

    util.inherits(_WorkflowError, restify.RestError);

    return new _WorkflowError();
};

/*
 * This error is produced when trying to call an action on a VM that is beying
 * destroyed (state === 'destroyed' && zone_state !== 'destroyed').
 * The only action allowed on such VMs is a POST with action=update and a
 * payload that only contains a value for the indestructible_zoneroot property
 * so that indestructible VMs can have this property disabled and be deleted.
 */
function VMBeingDestroyedError() {
    var message = 'Invalid operation while this VM is being destroyed';

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

util.inherits(VMBeingDestroyedError, restify.RestError);
VMBeingDestroyedError.prototype.name = 'VMBeingDestroyedError';
VMBeingDestroyedError.restCode = 'VMBeingDestroyed';
VMBeingDestroyedError.statusCode = 409;

/*
 * This error is produced when trying to call an action on a VM that is
 * already destroyed (state === 'destroyed').
 */
function ChangingDestroyedVMError() {
    var message = 'Invalid operation on a destroyed VM';

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

util.inherits(ChangingDestroyedVMError, restify.RestError);
ChangingDestroyedVMError.prototype.name = 'ChangingDestroyedVMError';
ChangingDestroyedVMError.restCode = 'ChangingDestroyedVM';
ChangingDestroyedVMError.statusCode = 409;

exports.UnallocatedVMError = UnallocatedVMError;
exports.ValidationFailedError = ValidationFailedError;
exports.BrandNotSupportedError = BrandNotSupportedError;
exports.VmNotRunningError = VmNotRunningError;
exports.VMBeingDestroyedError = VMBeingDestroyedError;
exports.ChangingDestroyedVMError = ChangingDestroyedVMError;
