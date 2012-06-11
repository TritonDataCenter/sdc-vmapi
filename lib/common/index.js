/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var util = require('./util');
var validation = require('./validation');
var vmcommon = require('./vm-common');

module.exports = {

    // Util
    clone: util.clone,
    simpleMerge: util.simpleMerge,
    shallowEqual: util.shallowEqual,

    // Validation helpers
    validUUID: validation.validUUID,
    validUUIDs: validation.validUUIDs,
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
    setMetadata: vmcommon.setMetadata,
    addMetadata: vmcommon.addMetadata,
    deleteMetadata: vmcommon.deleteMetadata,
    deleteAllMetadata: vmcommon.deleteAllMetadata,
    addTagsFilter: vmcommon.addTagsFilter

};