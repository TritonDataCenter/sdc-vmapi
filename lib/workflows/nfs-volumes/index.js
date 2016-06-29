/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * This module exports an object that has a "provisionChain" property which
 * represents a list of tasks that allows to provision NFS shared volumes that
 * are required/mounted by a given VM (e.g through the docker run -v
 * some-nfs-volume:/some-mountpoint command).
 * This list of task is currently used in the "provision" workflow.
 */

var vasync = require('vasync');
var VError = require('verror');

var common = require('../job-common');

function provisionNfsVolumes(job, cb) {
    var requiredVolumes;

    if (typeof (volapiUrl) === 'undefined') {
        cb(null, 'URL for volapi service not present, not provisioning NFS ' +
            'volumes');
        return;
    }

    requiredVolumes = job.params.volumes;
    if (requiredVolumes === undefined || requiredVolumes.length === 0) {
        /*
         * No need to provision any volume, because this VM does not
         * require any.
         */
        cb();
        return;
    }

    vasync.forEachParallel({
        func: provisionNfsVolume,
        inputs: requiredVolumes
    }, function onAllRequiredVolumesProvisioned(err, results) {
        job.log.info({err: err, results: results},
            'provisionNfsVolumes results');

        if (!err) {
            if (results === null || typeof (results) !== 'object') {
                cb(new Error('results must be an object'));
                return;
            }

            if (!Array.isArray(results.operations)) {
                cb(new Error('results.operations must be an array'));
                return;
            }

            var createdVolumes = {};
            var operationResultIndex;

            for (operationResultIndex in results.operations) {
                var operationResult =
                    results.operations[operationResultIndex].result;

                if (operationResult === null ||
                    typeof (operationResult) !== 'object') {
                    cb(new Error('operationResult must be an object'));
                    return;
                }

                createdVolumes[operationResult.uuid] = operationResult;
            }

            job.createdVolumes = createdVolumes;
            cb(null, 'All volumes provisioned');
        } else {
            cb(new VError(err, 'Could not provision volumes'));
        }
    });

    /*
     * This function is responsible for:
     *
     * 1. Reserving the volume with name "volumeName" for the owner of the VM
     * that is being provisioned.
     *
     * 2. Create that volume if it does not already exist.
     *
     * When this function call its "callback" function, it either:
     *
     * 1. succeeded to reserve the volume and create/load it
     *
     * 2. failed to reserve the volume
     *
     * 3. succeeded to reserve the volume, failed to create/load it, and
     * attempted to cancel the reservation.
     *
     * In cases 2 and 3, "callback" will be called with an error object as its
     * first argument.
     */
    function provisionNfsVolume(requiredVolume, callback) {
        var vmNics;
        var volumeName;

        if (typeof (requiredVolume) !== 'object' || requiredVolume === null) {
            callback(new Error('requiredVolume must be a non-null object'));
            return;
        }

        volumeName = requiredVolume.name;
        if (typeof (volumeName) !== 'string') {
            callback(new Error('volumeName must be a string'));
            return;
        }

        var volapi = new sdcClients.VOLAPI({
            url: volapiUrl,
            headers: { 'x-request-id': job.params['x-request-id'] },
            userAgent: 'workflow/' + job.name
        });

        if (job.params !== undefined) {
            vmNics = job.params.nics;
        }

        job.log.info({vmNics: vmNics}, 'VM nics');

        var provisionContext = {};

        vasync.pipeline({arg: provisionContext, funcs: [
            function loadVolume(ctx, next) {
                job.log.info({
                    name: volumeName,
                    owner_uuid: job.params.owner_uuid
                }, 'Loading volume');

                volapi.listVolumes({
                    name: volumeName,
                    owner_uuid: job.params.owner_uuid,
                    predicate: JSON.stringify({
                        eq: ['state', 'ready']
                    })
                }, function onListVolumes(listVolumesErr, volumes) {
                    var errMsg;
                    var err;

                    if (!listVolumesErr) {
                        if (volumes && volumes.length > 1) {
                            errMsg = 'more than one volume with name '
                                + volumeName + ' and owner_uuid: '
                                + job.params.owner_uuid + ' when we '
                                + 'expected exactly one';
                            job.log.error({volumes: volumes},
                                'Error: ' + errMsg);

                            err = new Error(errMsg);
                            next(err);
                            return;
                        }

                        if (volumes && volumes.length === 1) {
                            job.log.info({
                                volume: volumes[0]
                            }, 'Found volume');
                            ctx.volume = volumes[0];
                        } else {
                            job.log.info({
                                name: volumeName,
                                owner_uuid: job.params.owner_uuid
                            }, 'Did not find any volume');
                        }

                        next();
                    } else {
                        job.log.error({
                            error: listVolumesErr
                        }, 'Error when listing volumes');

                        /*
                         * Ignoring this error for now, since we'll try to
                         * create the volume later, and retry to load it if
                         * it already exists. If we get an error loading the
                         * volume then, we'll make the task fail.
                         */
                        next();
                    }
                });
            },
            function reserve(ctx, next) {
                if (job.params.vm_uuid === undefined) {
                    job.params.vm_uuid = uuid.v4();
                }

                job.log.info({
                    volume_uuid: ctx.volumeUuid,
                    job_uuid: job.uuid,
                    vm_uuid: job.params.vm_uuid,
                    owner_uuid: job.params.owner_uuid
                }, 'Reserving volume');

                volapi.createVolumeReservation({
                    owner_uuid: job.params.owner_uuid,
                    job_uuid: job.uuid,
                    vm_uuid: job.params.vm_uuid,
                    volume_name: volumeName
                }, function onVolRes(volResErr, volRes) {
                    ctx.volumeReservation = volRes;
                    next(volResErr);
                });
            },
            function provision(ctx, next) {
                var i;
                var fabricNetworkUuids = [];
                var invalidNics = [];
                var vmNic;
                var volumeCreationParams;

                if (ctx.volume) {
                    job.log.info({
                        volume: ctx.volume
                    }, 'Volume already exists, no need to create it');
                    next();
                    return;
                }

                job.log.info('Volume does not exist, creating it');

                volumeCreationParams = {
                    name: volumeName,
                    owner_uuid: job.params.owner_uuid,
                    type: 'tritonnfs'
                };

                /*
                 * If the volume doesn't exist, then we created its uuid
                 * beforehand to register a reservation for it, so we must
                 * pass that uuid to VOLAPI so that it uses that uuid when
                 * creating the volume to match the reservation.
                 */
                if (ctx.volumeUuid !== undefined) {
                    volumeCreationParams.uuid = ctx.volumeUuid;
                }

                /*
                 * If the VM being provisioned has nics attached to fabric
                 * networks, we'll attach the volume to be provisioned to the
                 * same networks. Otherwise, the default fabric network will be
                 * picked as a default by VOLAPI.
                 */
                for (i = 0; i < vmNics.length; ++i) {
                    vmNic = vmNics[i];

                    if (typeof (vmNic) !== 'object') {
                        invalidNics.push(vmNic);
                        continue;
                    }

                    if (vmNic.nic_tag &&
                        vmNic.nic_tag.indexOf('sdc_overlay/') === 0) {
                        fabricNetworkUuids.push(vmNic.network_uuid);
                    }
                }

                if (invalidNics.length > 0) {
                    next('invalid nics: ' + invalidNics);
                    return;
                }

                volumeCreationParams.networks = fabricNetworkUuids;

                volapi.createVolumeAndWait(volumeCreationParams,
                    onVolumeCreated);

                function onVolumeCreated(volumeCreationErr, createdVolume) {
                    if (!volumeCreationErr) {
                        job.log.info({createdVolume: createdVolume},
                            'Created new volume');
                        ctx.volume = createdVolume;
                        next();
                        return;
                    }

                    if (volumeCreationErr.restCode === 'VolumeAlreadyExists') {
                        job.log.info('Volume with name: ' +
                            volumeName + ' already exists, ' +
                            'loading it...');

                        volapi.listVolumes({
                            name: volumeName,
                            owner_uuid: job.params.owner_uuid,
                            predicate: JSON.stringify({
                                eq: ['state', 'ready']
                            })
                        }, function onListVolumes(listVolumesErr, volumes) {
                            var loadedVolume;
                            var errMsg;
                            var existingVolNumberMismatchErr;

                            if (listVolumesErr) {
                                job.log.error({
                                    err: listVolumesErr
                                }, 'Error when loading existing volume');
                                next(listVolumesErr);
                                return;
                            }

                            if (!volumes || (volumes && volumes.length !== 1)) {
                                errMsg =
                                    'Zero or more than one volume with name ' +
                                    volumeName + ' and ' + 'owner_uuid: ' +
                                    job.params.owner_uuid + ' when we ' +
                                    'expected exactly one';

                                job.log.error({volumes: volumes}, errMsg);

                                existingVolNumberMismatchErr =
                                    new Error(errMsg);
                                next(existingVolNumberMismatchErr);
                                return;
                            }

                            job.log.info({loadedVolume: loadedVolume},
                                'Loaded existing volume');
                            ctx.volume = volumes[0];
                            next();
                            return;
                        });
                    } else {
                        job.log.error({error: volumeCreationErr},
                            'Failed to created volume');
                        next(volumeCreationErr);
                        return;
                    }

                    next(volumeCreationErr);
                }
            }]}, function onVolumeProvDone(volProvErr) {
                if (provisionContext.volumeReservation === true &&
                    volProvErr !== undefined) {
                    job.log.info({
                        volumeReservation: provisionContext.volumeReservation
                    }, 'Cancelling volume reservation');

                    volapi.deleteVolumeReservation({
                        uuid: provisionContext.volumeReservation.uuid,
                        owner_uuid: job.params.owner_uuid
                    }, function onVolResRemoved(volResRemoveErr) {
                        if (volResRemoveErr) {
                            job.log.error({err: volResRemoveErr},
                                'Error when removing volume reservation');
                        } else {
                            job.log.info('Successfully removed volume ' +
                                'reservation');
                        }

                        callback(volProvErr, provisionContext.volume);
                    });
                } else {
                    callback(volProvErr, provisionContext.volume);
                }
            });
    }
}

/*
 * Prepares a request to CNAPI that updates the internal_metadata property of a
 * VM that depends on NFS volumes, in order for that VM to have the proper data
 * in its 'docker:nfsvolumes' internal_metadata property. That data is used by
 * dockerinit when the zone boots to mount exported filesystems from the
 * corresponding NFS shared volumes.
 *
 * This function only sets the request up. The request is performed later by
 * subsequent tasks in the same workflow. The next task with a body equal to
 * 'common.zoneAction' sends the request, and the task after with a body of
 * 'common.waitTask' waits for it to complete.
 */
function setupUpdateVmNfsVolumesMetadataRequest(job, callback) {
    if (job.updatedVmInternalMetadata === undefined) {
        // The VM's internal metadata doesn't need to be updated, so it's safe
        // to skip the rest of the task, and the subsequent zoneAction and
        // waitTask tasks.
        job.params.skip_zone_action = true;
        callback(null, 'VM internal metadata doesn\'t need to be updated');
        return;
    }

    if (job.updatedVmInternalMetadata === null ||
        typeof (job.updatedVmInternalMetadata) !== 'object') {
        callback(new Error('job.updatedVmInternalMetadata must be an object'));
        return;
    }

    job.endpoint = '/servers/' +
                   job.params.server_uuid + '/vms/' +
                   job.params.vm_uuid + '/update';
    job.params.jobid = job.uuid;
    job.requestMethod = 'post';
    job.action = 'update';
    job.server_uuid = job.params['server_uuid'];

    job.params.payload = {
        set_internal_metadata: job.updatedVmInternalMetadata
    };

    return callback(null, 'Request has been setup!');
}


function buildNfsVolumesMetadata(job, callback) {
    job.log.info({createdVolumes: job.createdVolumes},
        'Building docker:nfsvolumes internal metadata');

    if (job.createdVolumes === undefined) {
        // No NFS volume was created, so there's no need to update the
        // docker:nfsvolumes metadata for dockerinit to mount any volume.
        callback(null, 'No NFS volume with which to update VM\'s internal '
            + 'metadata');
        return;
    }

    if (job.createdVolumes === null ||
        typeof (job.createdVolumes) !== 'object') {
        callback(new Error('job.createdVolumes must be an object'));
        return;
    }

    if (Object.keys(job.createdVolumes).length === 0) {
        callback(null, 'No NFS volume with which to update VM\'s internal '
            + 'metadata');
        return;
    }

    var createdVolume;
    var foundVolume;
    var requiredVolumes = job.params.volumes;
    var volume;
    var volumeIndex;
    var volumeUuid;

    if (!Array.isArray(requiredVolumes)) {
        callback(new Error('requiredVolumes must be an array'));
        return;
    }

    for (volumeUuid in job.createdVolumes) {
        createdVolume = job.createdVolumes[volumeUuid];

        job.log.info('Updating docker:nfsvolumes metadata entry for volume: '
            + createdVolume.name);

        foundVolume = false;

        for (volumeIndex in requiredVolumes) {
            volume = requiredVolumes[volumeIndex];
            if (volume && volume.name === createdVolume.name) {
                foundVolume = true;
                break;
            }
        }

        if (foundVolume) {
            job.log.info('Adding filesystem_path property ['
                + createdVolume.filesystem_path + '] to '
                + 'required volume: ' + createdVolume.name);
            requiredVolumes[volumeIndex].filesystem_path =
                createdVolume.filesystem_path;
        }
    }

    job.nfsVolumesInternalMetadata =
        JSON.stringify(requiredVolumes.map(volumeToNfsInternalMetadata));

    callback(null, 'Built docker:nfsvolumes internal_metadata: '
        + job.nfsVolumesInternalMetadata);

    function volumeToNfsInternalMetadata(vol) {
        return {
            mode: (vol.mode === undefined) ? 'rw' : vol.mode,
            mountpoint: vol.mountpoint,
            name: vol.name,
            nfsvolume: vol.filesystem_path,
            type: (vol.type === undefined) ? 'tritonnfs' : vol.type
        };
    }
}


function waitForNfsVolumeProvisions(job, callback) {
    if (job.requiredNfsVolumes !== undefined &&
        !Array.isArray(job.requiredNfsVolumes)) {
        callback(new Error('job.requiredNfsVolumes must be an array if '
            + 'present'));
        return;
    }

    if (!job.createdVolumes || Object.keys(job.createdVolumes).length === 0) {
        callback(null, 'No required NFS volume to wait for');
        return;
    }

    var volapi = new sdcClients.VOLAPI({
        url: volapiUrl,
        headers: {'x-request-id': job.params['x-request-id']},
        userAgent: 'workflow/' + job.name
    });

    vasync.forEachParallel({
        func: function checkVolumeCreated(nfsVolumeUuid, done) {
            if (typeof (nfsVolumeUuid) !== 'string') {
                done(new Error('nfsVolumeUuid must be a string'));
                return;
            }

            function checkVolumeReady() {
                volapi.getVolume({
                    uuid: nfsVolumeUuid,
                    owner_uuid: job.params.owner_uuid
                }, function onGetVolume(getVolumeErr, volume) {
                    if (getVolumeErr) {
                        done(getVolumeErr);
                        return;
                    }

                    if (volume && volume.state === 'ready') {
                        job.createdVolumes[volume.uuid] = volume;
                        done();
                        return;
                    }

                    setTimeout(checkVolumeReady, 1000);
                });
            }

            checkVolumeReady();
        },
        inputs: Object.keys(job.createdVolumes)
    }, function allVolumesReady(err, results) {
        if (err) {
            callback(new Error('Could not determine if all required volumes '
                + 'are ready'));
        } else {
            callback(null, 'All required volumes ready');
        }
    });
}

function addVolumesReferences(job, callback) {
    var createdVolumeUuids = [];

    if (job.createdVolumes !== undefined &&
        typeof (job.createdVolumes) !== 'object') {
        callback(new Error('job.createdVolumes must be an object if '
            + 'present'));
        return;
    }

    if (job.createdVolumes) {
        createdVolumeUuids = Object.keys(job.createdVolumes);
    }

    if (createdVolumeUuids.length === 0) {
        callback(null,
            'No created NFS volume to which a reference needs to be added');
        return;
    }

    var volapi = new sdcClients.VOLAPI({
        url: volapiUrl,
        headers: {'x-request-id': job.params['x-request-id']},
        userAgent: 'workflow/' + job.name
    });

    var vmUuid = job.params.vm_uuid;

    vasync.forEachParallel({
        func: function addVolReference(volUuid, done) {
            volapi.addVolumeReference({
                owner_uuid: job.params.owner_uuid,
                vm_uuid: vmUuid,
                volume_uuid: volUuid
            }, done);
        },
        inputs: createdVolumeUuids
    }, function onRefsAdded(refsAddErr) {
        if (refsAddErr) {
            callback(new Error('Could not add references from VM ' + vmUuid +
                ' to volumes ' + createdVolumeUuids));
        } else {
            callback(null, 'References from VM ' + vmUuid + ' to volumes ' +
                createdVolumeUuids + ' added successfully');
        }
    });
}

/*
 * Note that this workflow job task never fails. In case of error, it still
 * never calls its "callback" with an error object, only with a message that
 * describes the error encountered. Removing volume references is indeed a best
 * effort task because:
 *
 * 1. we want to keep the destroy job as quick as possible so that users get a
 *    response back as quickly as possible.
 *
 * 2. a VOLAPI service might not be available, in this case we don't want to
 *    make VM destroy jobs fail just because we failed to remove volume
 *    references.
 *
 * 3. In case we fail to remove volume references here, the "volapi-updater"
 *    process will remove them asynchronously.
 */
function removeVolumesReferences(job, callback) {
    if (typeof (volapiUrl) === 'undefined') {
        callback(null,
            'URL for volapi service not present, not provisioning NFS volume');
        return;
    }

    if (!job.currentVm) {
        callback(null, 'Skipping task -- VM missing from job');
        return;
    }

    /*
     * If the VM being destroyed doesn't use any volume, there's no point in
     * removing volume references.
     */
    if (!job.currentVm.internal_metadata ||
        job.currentVm.internal_metadata['sdc:volumes'] === undefined) {
        callback(null,
            'Skipping task -- VM is missing volumes internal_metadata');
        return;
    }

    /*
     * Even if the VM being destroyed depends on volumes, we want to minimize
     * the time spent trying to remove volume references. Thus, we disable the
     * retry mechanism provided by sdc-clients, and we set a connection timeout
     * of 5 seconds (which is set to be < than the task's timeout in the destroy
     * workflow), instead of using the defaults provided by the node runtime
     * which is 2 minutes. This applies e.g if NFS volumes are enabled in a
     * given DC, and then disabled with the VOLAPI core service's instance
     * deleted: the client would retry indefinitely to connect until the task's
     * timeout expire. With this change it doesn't retry and requests call the
     * callback with a connection error after at most 5 seconds.
     */
    var volapi = new sdcClients.VOLAPI({
        url: volapiUrl,
        headers: {'x-request-id': job.params['x-request-id']},
        userAgent: 'workflow/' + job.name,
        connectTimeout: 5000,
        retry: false
    });

    var vmUuid = job.params.vm_uuid;

    volapi.listVolumes({
        refs: vmUuid
    }, function onRefedVolsListed(listErr, refedVolumes) {
        if (listErr) {
            callback(null, 'Failed to list volumes referenced by VM ' + vmUuid +
                ', reason: ' + listErr);
            return;
        }

        job.log.info({
            vmUuid: vmUuid,
            refedVolumes: refedVolumes,
            err: listErr
        }, 'listed volumes referenced by VM prior to removing references');

        vasync.forEachParallel({
            func: function removeVolReference(volume, done) {
                job.log.info({
                    owner_uuid: job.params.owner_uuid,
                    vm_uuid: vmUuid,
                    volume_uuid: volume.uuid
                }, 'removing reference from VM to volume');

                volapi.removeVolumeReference({
                    owner_uuid: job.params.owner_uuid,
                    vm_uuid: vmUuid,
                    volume_uuid: volume.uuid
                }, done);
            },
            inputs: refedVolumes
        }, function onRefsRemoved(refsDelErr) {
            if (refsDelErr) {
                callback(null, 'Could not remove references from VM ' +
                    vmUuid + ' to volumes ' + refedVolumes);
            } else {
                callback(null, 'References from VM ' + vmUuid + ' to volumes ' +
                    refedVolumes + ' removed successfully');
            }
        });
    });
}

module.exports = {
    provisionChain: [
        {
            name: 'volapi.provision_nfs_volumes',
            timeout: 120,
            retry: 1,
            body: provisionNfsVolumes,
            modules: {
                sdcClients: 'sdc-clients',
                uuid: 'uuid',
                vasync: 'vasync',
                VError: 'verror'
            }
        }, {
            name: 'cnapi.wait_for_nfs_volumes_provisions',
            timeout: 120,
            retry: 1,
            body: waitForNfsVolumeProvisions,
            modules: {
                sdcClients: 'sdc-clients',
                vasync: 'vasync'
            }
        }, {
            name: 'cnapi.build_nfs_volumes_metadata',
            timeout: 10,
            retry: 1,
            body: buildNfsVolumesMetadata,
            modules: {
                sdcClients: 'sdc-clients',
                vasync: 'vasync'
            }
        }
    ],
    addVolumesReferences: addVolumesReferences,
    removeVolumesReferences: removeVolumesReferences
};
