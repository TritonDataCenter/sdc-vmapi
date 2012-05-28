/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var util = require('./util');
var validation = require('./validation');
var mcommon = require('./machine-common');

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

    // Machine validation
    validateMachine: validation.validateMachine,
    validateParams: validation.validateParams,
    validateUniqueAlias: validation.validateUniqueAlias,
    validateUpdate: validation.validateUpdate,
    setDefaultValues: validation.setDefaultValues,

    // Machine common
    machineOwner: mcommon.machineOwner,
    translateMachine: mcommon.translateMachine,
    translateJob: mcommon.translateJob,
    keyValueToObject: mcommon.keyValueToObject,
    objectToKeyValue: mcommon.objectToKeyValue,
    machineToUfds: mcommon.machineToUfds,
    addMetadata: mcommon.addMetadata,
    deleteMetadata: mcommon.deleteMetadata,
    deleteAllMetadata: mcommon.deleteAllMetadata,
    addTagsFilter: mcommon.addTagsFilter

};