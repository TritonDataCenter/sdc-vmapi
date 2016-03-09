var assert = require('assert-plus');

var libuuid = require('libuuid');

var common = require('../../lib/common');

var TEST_VMS_ALIAS_PREFIX = 'test-vmapi';
exports.TEST_VMS_ALIAS_PREFIX = TEST_VMS_ALIAS_PREFIX;

function BunyanNoopLogger() {}
BunyanNoopLogger.prototype.trace = function () {};
BunyanNoopLogger.prototype.debug = function () {};
BunyanNoopLogger.prototype.info = function () {};
BunyanNoopLogger.prototype.warn = function () {};
BunyanNoopLogger.prototype.error = function () {};
BunyanNoopLogger.prototype.fatal = function () {};
BunyanNoopLogger.prototype.child = function () { return this; };
BunyanNoopLogger.prototype.end = function () {};

function createTestVm(moray, options, vmParams, callback) {
    assert.object(moray, 'moray');
    assert.object(options, 'options');
    assert.object(vmParams, 'vmParams must be an object');

    var log = options.log || new BunyanNoopLogger();

    vmParams = common.clone(vmParams);
    common.setDefaultValues(vmParams, {});

    // Prefix the VM alias with a prefix that identifies it as a test VM, and
    // suffix it with a string that makes it unique.
    vmParams.alias = getTestVmName({
        uniqueAlias: options.uniqueAlias,
        debugName: vmParams.alias
    });

    if (vmParams.create_timestamp === undefined)
        vmParams.create_timestamp = Date.now();

    if (vmParams.last_modified === undefined)
        vmParams.last_modified = Date.now();

    vmParams.uuid = libuuid.create();

    log.debug({vmParams: vmParams}, 'params before translation');

    vmParams = common.translateVm(vmParams, false);
    log.debug({vmParams: vmParams}, 'params after translation');

    moray.putVm(vmParams.uuid, vmParams, function (err) {
        if (err) {
            log.error({ err: err, vmParams: vmParams },
                'Error storing VM %s in moray', vmParams.uuid);
        }

        return callback(err, vmParams.uuid);
    });
}
exports.createTestVm = createTestVm;

function createTestVMs(nbTestVmsToCreate, moray, options, vmParams, callback) {
    assert.number(nbTestVmsToCreate, 'nbTestVmsToCreate');
    assert.object(moray, 'moray');
    assert.object(options, 'options');
    assert.object(vmParams, 'vmParams must be an object');
    assert.func(callback, 'callback');

    var log = options.log || new BunyanNoopLogger();

    var nbTestVmsCreated = 0;
    var testVmsUuid = [];
    var concurrency = 0;
    var DEFAULT_MAX_CONCURRENCY = 60;
    var maxConcurrency = options.concurrency || DEFAULT_MAX_CONCURRENCY;

    var vmCreationOpion = {
        log: log,
        uniqueAlias: true
    };

    if (options.uniqueAlias === false)
        vmCreationOpion.uniqueAlias = false;

    for (var i = 0; i < maxConcurrency && i < nbTestVmsToCreate; ++i)
        spawnVmCreation();

    function spawnVmCreation() {
        log.trace('spawning VM creation');
        ++concurrency;

        createTestVm(moray, vmCreationOpion, vmParams,
            function vmCreated(err, vmUuid) {
                --concurrency;

                if (!err) {
                    ++nbTestVmsCreated;
                    testVmsUuid.push(vmUuid);
                }

                log.trace('nb VMs created so far:', nbTestVmsCreated);

                if (nbTestVmsCreated < nbTestVmsToCreate) {
                    if (nbTestVmsCreated + concurrency < nbTestVmsToCreate &&
                        concurrency < maxConcurrency) {
                        spawnVmCreation();
                    }
                } else {
                    return callback(null, testVmsUuid);
                }
            });
    }
}
exports.createTestVMs = createTestVMs;

exports.deleteTestVMs = function deleteTestVMs(moray, params, callback) {
    assert.object(moray, 'moray');
    assert.object(params, 'params');
    assert.func(callback, 'callback');

    if (params.alias)
        params.alias = TEST_VMS_ALIAS_PREFIX + '-' + params.alias;
    else
        params.alias = TEST_VMS_ALIAS_PREFIX;

    // Even though we don't want to delete all VMs,
    // delete the complete subset of VMs if it's higher than
    // the default moray limit (hardcoded to 1000 currently)
    params.noLimit = true;

    // Make sure that the alias set is not empty so that we don't delete
    // all VMs
    assert.string(TEST_VMS_ALIAS_PREFIX);
    assert.ok(TEST_VMS_ALIAS_PREFIX.length > 0);
    assert.equal(params.alias.indexOf(TEST_VMS_ALIAS_PREFIX), 0);

    return moray.delVms(params, callback);
};

function getTestVMsPrefix(debugName) {
    assert.optionalString(debugName, 'debugName');

    var resourceNameComponents = [ TEST_VMS_ALIAS_PREFIX ];

    if (debugName) {
        resourceNameComponents.push(debugName);
    }

    return (resourceNameComponents.join('-'));
}
exports.getTestVMsPrefix = getTestVMsPrefix;

function getUniqueTestVMName(debugName) {
    assert.optionalString(debugName, 'debugName');

    var shortId = libuuid.create().substr(0, 8);

    return (getTestVMsPrefix(debugName) + '-' + shortId);
}
exports.getUniqueTestVMName =  getUniqueTestVMName;

function getTestVmName(options) {
    assert.object(options, 'options');

    if (options.uniqueAlias) {
        return getUniqueTestVMName(options.debugName);
    } else {
        return getTestVMsPrefix(options.debugName);
    }
}
exports.getTestVmName = getTestVmName;
