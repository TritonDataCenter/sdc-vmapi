/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
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
        message: opts.message || 'Unknown Error',
        constructorOpt: _WorkflowError
    };

    function _WorkflowError() {
        restify.RestError.call(this, erropts);
        // Always need a .name so that if we get passed to restify we don't
        // cause it to blow up since it depends on all errors having .name.
        this.name = error.name || 'WfapiError';
    }
    _WorkflowError.restCode = erropts.restCode;
    _WorkflowError.statusCode = erropts.statusCode;

    util.inherits(_WorkflowError, restify.RestError);

    return new _WorkflowError();
};


exports.UnallocatedVMError = UnallocatedVMError;
exports.ValidationFailedError = ValidationFailedError;
exports.BrandNotSupportedError = BrandNotSupportedError;
exports.VmNotRunningError = VmNotRunningError;

function MorayBucketsNotSetupError(lastInitError) {
    assert.optionalObject(lastInitError, 'lastInitError');

    var message = 'Moray buckets are not setup';
    if (lastInitError) {
        message += ', last buckets setup error: ' + lastInitError;
    }

    restify.ServiceUnavailableError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: message,
        body: {
            code: this.constructor.restCode,
            message: message,
            lastInitError: lastInitError
        }
    });
}
util.inherits(MorayBucketsNotSetupError, restify.ServiceUnavailableError);
MorayBucketsNotSetupError.prototype.name = 'MorayBucketsNotSetupError';
MorayBucketsNotSetupError.restCode = 'MorayBucketsNotSetup';
MorayBucketsNotSetupError.statusCode = 503;
exports.MorayBucketsNotSetupError = MorayBucketsNotSetupError;

function InvalidIndexesRemovalError(indexes) {
    Error.call(this);

    assert.arrayOfString(indexes, 'indexes');
    this.name = this.constructor.name;
    this.message = 'Invalid removal of indexes: ' + indexes.join(', ');
}
util.inherits(InvalidIndexesRemovalError, Error);
exports.InvalidIndexesRemovalError = InvalidIndexesRemovalError;

function DataVersionError(modelName, requiredVer, actualVer, featureDesc) {
    var message;

    assert.string(modelName, 'modelName');
    assert.number(requiredVer, 'requiredVersion');
    assert.optionalNumber(actualVer, 'actualVersion');
    assert.string(featureDesc, 'featureDesc');

    message = 'Data for model ' + modelName + ' not at required version ' +
        requiredVer + ' to support ' + featureDesc + '. Current data ' +
        'version is: ' + actualVer;

    restify.ServiceUnavailableError.call(this, {
        restCode: this.constructor.restCode,
        statusCode: this.constructor.statusCode,
        message: message,
        body: {
            code: this.constructor.restCode,
            message: message
        }
    });
}
util.inherits(DataVersionError, Error);
DataVersionError.prototype.name = 'DataVersionError';
DataVersionError.restCode = 'DataVersion';
DataVersionError.statusCode = 503;
exports.DataVersionError = DataVersionError;

function InvalidDataMigrationFileNamesError(fileNames) {
    if (!(this instanceof InvalidDataMigrationFileNamesError)) {
        throw new Error('InvalidDataMigrationFileNamesError must be used as ' +
            'a constructor');
    }

    Error.call(this);

    assert.arrayOfString(fileNames, 'fileNames');
    this.name = this.constructor.name;
    this.message = 'Invalid data migration file name: ' + fileNames.join(',');
}
util.inherits(InvalidDataMigrationFileNamesError, Error);
exports.InvalidDataMigrationFileNamesError = InvalidDataMigrationFileNamesError;