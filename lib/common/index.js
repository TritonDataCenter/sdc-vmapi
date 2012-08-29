/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var util = require('./util');
var validation = require('./validation');
var vmcommon = require('./vm-common');
var errors = require('./errors');


// TODO dynamiclally load-export these things

module.exports = {

    // Util
    clone: util.clone,
    simpleMerge: util.simpleMerge,
    shallowEqual: util.shallowEqual,
    timestamp: util.timestamp,

    // Validation helpers
    validUUID: validation.validUUID,
    validUUIDs: validation.validUUIDs,
    validMetadata: validation.validMetadata,
    validAlias: validation.validAlias,
    validBrand: validation.validBrand,
    validNumber: validation.validNumber,
    validOwner: validation.validOwner,

    // VM validation
    validateVm: validation.validateVm,
    validateParams: validation.validateParams,
    validateUniqueAlias: validation.validateUniqueAlias,
    validateUpdate: validation.validateUpdate,
    setDefaultValues: validation.setDefaultValues,

    // VM common
    vmOwner: vmcommon.vmOwner,
    translateVm: vmcommon.translateVm,
    translateJob: vmcommon.translateJob,
    keyValueToObject: vmcommon.keyValueToObject,
    objectToKeyValue: vmcommon.objectToKeyValue,
    vmToUfds: vmcommon.vmToUfds,
    vmToHash: vmcommon.vmToHash,
    setMetadata: vmcommon.setMetadata,
    addMetadata: vmcommon.addMetadata,
    deleteMetadata: vmcommon.deleteMetadata,
    deleteAllMetadata: vmcommon.deleteAllMetadata,
    addTagsFilter: vmcommon.addTagsFilter,
    getStatuses: vmcommon.getStatuses,

    // Custom Errors
    UnallocatedVMError: errors.UnallocatedVMError

};