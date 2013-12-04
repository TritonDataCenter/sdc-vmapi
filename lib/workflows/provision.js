/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var async = require('async');
var restify = require('restify');
var common = require('./job-common');
var childProcess = require('child_process');

var VERSION = '7.0.20';


/*
 * Validates that the needed provision parameters are present
 */
function validateParams(job, cb) {
    if (dapiUrl === undefined) {
        return cb('No DAPI URL provided');
    }

    if (napiUrl === undefined) {
        return cb('No NAPI parameters provided');
    }

    if (ufdsUrl === undefined || ufdsDn === undefined ||
        ufdsPassword === undefined) {
        return cb('No UFDS parameters provided');
    }

    if (cnapiUrl === undefined) {
        return cb('No CNAPI URL provided');
    }

    if (fwapiUrl === undefined) {
        return cb('No FWAPI URL provided');
    }

    if (imgapiUrl === undefined) {
        return cb('No IMGAPI URL provided');
    }

    if (job.params['owner_uuid'] === undefined) {
        return cb('\'owner_uuid\' is required');
    }

    if (job.params.brand === undefined) {
        return cb('VM \'brand\' is required');
    }

    return cb(null, 'All parameters OK!');
}



/*
 * Gets the Image that corresponds to the image_uuid parameter
 */
function getImage(job, cb) {
    var imgapi = restify.createJsonClient({
        url: imgapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });
    var imageUuid = job.params['image_uuid'] ||
                    job.params.disks[0]['image_uuid'];

    if (imageUuid === undefined) {
        return cb('image_uuid was not found in the payload');
    }

    var path = '/images/' + imageUuid;

    return imgapi.get(path, function (err, req, res, image) {
        if (err) {
            return cb(err);
        } else {
            job.image = image;
            return cb(null, 'Got image');
        }
    });
}



/*
 * Generates passwords when the image requires it
 */
function generatePasswords(job, cb) {
    var log = job.log;
    var execFile = childProcess.execFile;
    var PWD_LENGTH = 12;
    var APG_COMMAND = '/opt/local/bin/apg';
    var APG_ARGS = [
        '-m', PWD_LENGTH,
        '-M', 'SCNL',
        '-n', 1,
        '-E', '"\'@$%&*/.:[]\\'
    ];

    if (job.image === undefined) {
        return cb(null, 'Image object was not set, skipping generatePasswords');
    }

    if (job.image['generate_passwords'] === false) {
        return cb(null, 'No need to generate passwords for image');
    }

    if (job.image.users === undefined || !Array.isArray(job.image.users)) {
        return cb(null, 'Image has generate_passwords=true but no users found');
    }

    if (job.params['internal_metadata'] === undefined) {
        job.params['internal_metadata'] = {};
    }

    var users = job.image.users;
    var name;
    var password;

    async.mapSeries(users, function (user, next) {
        name = user.name + '_pw';
        if (job.params['internal_metadata'][name]  === undefined) {
            execFile(APG_COMMAND, APG_ARGS, function (err, stdout, stderr) {
                if (err) {
                    log.info({ err: err }, 'Error generating random password');
                    return next(err);
                }

                password = stdout.toString().replace(/\n|\r/g, '');
                job.params['internal_metadata'][name] = password;
                return next();
            });
        } else {
            return next();
        }
    }, function (err) {
        if (err) {
            cb(err, 'Could not generate passwords');
        } else {
            cb(null, 'Passwords generated for Image');
        }
    });
}



/*
 * Adds a custom vmusage object to UFDS. This object is used by the cloudapi
 * limits plugin in order to determine if a customer should be able to provision
 * more machines
 */
function addCustomerVm(job, cb) {
    job.log.info('enter addCustomerVm');
    var dn = 'vm=' + job.params['vm_uuid'] + ', uuid=' +
            job.params['owner_uuid'] + ', ou=users, o=smartdc';
    var vm = {
        objectclass: 'vmusage',
        ram: job.params.ram || job.params.max_physical_memory,
        quota: job.params.quota,
        uuid: job.params['vm_uuid'],
        image_uuid: job.params['image_uuid'] ||
                    job.params.disks[0]['image_uuid']
    };

    var ufdsOptions = {
        url: ufdsUrl,
        bindDN: ufdsDn,
        bindPassword: ufdsPassword
    };

    var UFDS = new sdcClients.UFDS(ufdsOptions);

    UFDS.on('ready', addVm);
    UFDS.on('error', function (err) {
        return cb(err);
    });

    function addVm() {
        job.log.info('enter addVm');
        if (job.params['image_os']) {
            vm['image_os'] = job.params['image_os'];
        }

        if (job.params['image_name']) {
            vm['image_name'] = job.params['image_name'];
        }

        if (job.params['billing_id']) {
            vm['billing_id'] = job.params['billing_id'];
        }

        try {
            UFDS.add(dn, vm, onAddVm);
        } catch (err) {
            cb(err);
        }
    }

    function onAddVm(err) {
        job.log.info('enter onAddVm');
        if (err) {
            return cb(err);
        }

        job.addedToUfds = true;
        return cb(null, 'Customer VM usage added to UFDS');
    }
}



/*
 * Gets a list of NIC tags given the network uuids provided
 */
function getNicTags(job, cb) {
    var networks = job.params.networks;
    var newNetworks = [];
    if (!networks) {
        cb('Networks are required');
    }

    var napi = new sdcClients.NAPI({
        url: napiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    job.nicTags = [];

    // - Resolve network names to uuids when applicable
    // - Repopulate job.params.networks
    // - Returns cb(err, uuid). uuid is present when name was resolved to uuid
    function getNetwork(netId, callback) {
        /*JSSTYLED*/
        var UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
        var netFn, poolFn;
        var params;

        // Network can be either by name or uuid
        if (UUID_RE.test(netId)) {
            params = netId;
            netFn = napi.getNetwork;
            poolFn = napi.getNetworkPool;
        } else {
            params = { name: netId };
            netFn = napi.listNetworks;
            poolFn = napi.listNetworkPools;
        }

        netFn.call(napi, params, function (err, nets) {
            if (!err) {
                // Did we get the network from list or get?
                var net = (Array.isArray(nets) ? nets[0] : nets);
                job.nicTags.push(net.nic_tag);
                return callback(null, net.uuid);
            }

            // We might be trying to provision on a network pool, so
            // try that instead
            poolFn.call(napi, params, function (err2, pools) {
                if (err2) {
                    // Return the original error
                    return callback(err);
                }

                // NAPI-121: listNetworkPools should accept a name
                if (Array.isArray(pools)) {
                    pools = pools.filter(function (pool) {
                        return pool.name === netId;
                    });
                    if (pools.length) {
                        job.nicTags.push(pools[0].nic_tag);
                        callback(null, pools[0].uuid);
                    } else {
                        callback(new Error('No such Network Pool with ' +
                            'name: ' + netId));
                    }
                } else {
                    job.nicTags.push(pools.nic_tag);
                    callback(null, pools.uuid);
                }
            });
        });
    }

    async.mapSeries(networks, function (network, next) {
        var netId;
        if (network.uuid !== undefined) {
            netId = network.uuid;
        } else if (network.name !== undefined) {
            netId = network.name;
        }

        getNetwork(netId, function (err, uuid) {
            if (err) {
                next(err);
            } else {
                network.uuid = uuid;
                newNetworks.push(network);
                next();
            }
        });

    }, function (err2) {
        if (err2) {
            cb(err2);
        } else {
            job.params.networks = newNetworks;
            job.log.info({nicTags: job.nicTags}, 'NIC Tags retrieved');
            cb(null, 'NIC Tags retrieved');
        }
    });
}



/*
 * Gets a list of servers from CNAPI.
 *
 * First we get a list of server UUIDs given the NIC tags specified by the
 * networks in the provision request. All of the NICs that NAPI returns must
 * belong to a server, that's why the belongs_to_type parameter is present. The
 * list of server UUIDs that gets constructed is passed to the second function,
 * which in turns constructs a list of servers from those UUIDs by calling
 * CNAPI's listServers function. Note that if you pass params['server_uuid'],
 * this function will be skipped because you are already specifying the server
 * you want to provision to
 */
function getServers(job, cb) {
    if (job.params['server_uuid']) {
        return cb(null, 'Server UUID present, no need to get servers');
    }

    var nicTags = job.nicTags;

    if (!nicTags) {
        return cb('NIC Tags are required');
    }

    var commonHeaders = { 'x-request-id': job.params['x-request-id'] };
    var napi = new sdcClients.NAPI({ url: napiUrl, headers: commonHeaders });
    var cnapi = new sdcClients.CNAPI({ url: cnapiUrl, headers: commonHeaders });

    var serverUuids = [];

    async.series([
    function napiGetUuids(next) {
        var params = {
            belongs_to_type: 'server',
            nic_tags_provided: job.nicTags
        };

        napi.listNics(params, function (err, nics) {
            if (err) {
                next(err);
            } else {
                job.log.debug(nics.map(function (n) { return n.mac; }),
                    'NICs retrieved from NAPI');

                for (var j = 0; j < nics.length; j++) {
                    var nic = nics[j];

                    // Might be the case that we want 2 nics on the same network
                    if (serverUuids.indexOf(nic['belongs_to_uuid']) == -1) {
                        serverUuids.push(nic['belongs_to_uuid']);
                    }
                }

                job.log.info({ serverUuids: serverUuids },
                    'Server UUIDs retrieved');
                next();
            }
        });
    },
    function cnapiGetServers(next) {
        var params = {
            extras: 'sysinfo,memory,vms,disk',
            uuids: serverUuids.join(',')
        };

        cnapi.listServers(params, function (err, servers) {
            if (err) {
                next(err);
            } else {
                if (Array.isArray(servers) && servers.length) {
                    job.servers = servers;
                    job.log.debug(servers.map(function (s) { return s.UUID; }),
                        'getServers: servers found');

                    next();
                } else {
                    next(new Error('No servers found on CNAPI'));
                }
            }
        });
    }],
    function (err, result) {
        return (err ? cb(err) : cb(null, 'Got servers'));
    });
}



/*
 * A server Network Interfaces sysinfo object looks like this
 *
 * "Network Interfaces": {
 *   "e1000g0": {
 *     "MAC Address": "00:50:56:3d:a7:95",
 *     "ip4addr": "",
 *     "Link Status": "up",
 *     "NIC Names": [
 *       "external"
 *     ]
 *   },
 *   "e1000g1": {
 *     "MAC Address": "00:50:56:34:60:4c",
 *     "ip4addr": "10.99.99.7",
 *     "Link Status": "up",
 *     "NIC Names": [
 *       "admin"
 *     ]
 *   }
 * }
 *
 * Each server in the list must have all the nic tags specified. So if we want
 * to provision a machine with admin and external the server must have the two
 * interfaces available. The previous step doesn't do that because we ask NAPI
 * for nics with either admin or external. Now we need to make sure to only pick
 * which of those servers have both nic tags available
 */
function filterServers(job, cb) {
    if (job.params['server_uuid']) {
        return cb(null, 'Server UUID present, no need to filter servers');
    }

    var filtered = [];
    var i, j;
    var numTags = job.nicTags.length;

    // Goes inside the "NIC Names" array and extracts the NIC Tags for each NIC
    function mapNics(object) {
        var nics = [];

        for (var key in object) {
            var subNics = object[key]['NIC Names'];
            nics = nics.concat(subNics);
        }

        return nics;
    }

    for (i = 0; i < job.servers.length; i++) {
        var server = job.servers[i];
        var serverNics = mapNics(server.sysinfo['Network Interfaces']);
        var count = 0;

        for (j = 0; j < numTags; j++) {
            var nicTag = job.nicTags[j];
            if (serverNics.indexOf(nicTag) != -1) {
                count++;
            }
        }

        if (count == numTags) {
            filtered.push(server);
        }
    }

    job.log.debug({ nicTagsWanted: job.nicTags,
        filteredServers: filtered.map(function (s) { return s.uuid; })
    }, 'Results of filtering servers');
    if (filtered.length > 0) {
        job.filteredServers = filtered;
        return cb(null, 'Filtered servers with NIC Tag requirements');
    } else {
        return cb('None of the servers meet the NIC Tag requirements');
    }
}



/*
 * Allocates a server for the VM payload desired. This function will send a list
 * of servers and a VM payload to DAPI and let it figure out which server best
 * fits our needs. Note that if you pass params['server_uuid'], this function
 * will be skipped because you are already specifying the server you want to
 * provision to
 */
function getAllocation(job, cb) {
    if (job.params['server_uuid']) {
        cb(null, 'Server UUID present, no need to get allocation from DAPI');
        return;
    }

    // There is no sdc-client for DAPI yet
    var dapi = restify.createJsonClient({
        url: dapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    // See manta-beta guard in `getImage()` above.
    var image = job.image || {};

    var payload = {
        servers: job.filteredServers,
        vm: job.params,
        image: image,
        package: job.package
    };

    job.log.info({ dapiPayload: payload }, 'Payload sent to DAPI');

    return dapi.post('/allocation', payload, function (err, req, res, body) {
        // Cleanup even if it fails
        delete job.servers;
        delete job.filteredServers;

        if (err) {
            return cb(err);
        } else {
            job.params['server_uuid'] = body.server.uuid;
            return cb(null, 'Server allocated!');
        }
    });
}



/*
 * Calls the provision endpoint on CNAPI. This function is very similar to
 * common.zoneAction. Here, we also make sure if we are trying to provision an
 * autoboot machine, in which case the job.expects attribute value should be
 * stopped (and then common.checkState waits for the machine to be stopped)
 */
function provision(job, cb) {
    var cnapi = new sdcClients.CNAPI({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });
    job.params.jobid = job.uuid;

    // autoboot=false means we want the machine to not to boot after provision
    if (job.params.autoboot === false || job.params.autoboot === 'false') {
        job.expects = 'stopped';
    } else {
        job.expects = 'running';
    }

    var server = job.params['server_uuid'];

    function preparePayload(params) {
        var i, j, nic;
        var payload = { uuid: params['vm_uuid'], image: job.image };
        var wantResolvers = true;

        var keys = [ 'alias', 'autoboot', 'billing_id', 'brand', 'cpu_cap',
            'cpu_shares', 'customer_metadata', 'delegate_dataset', 'dns_domain',
            'firewall_enabled', 'fs_allowed', 'hostname', 'internal_metadata',
            'limit_priv', 'max_locked_memory', 'max_lwps',
            'max_physical_memory', 'max_swap', 'mdata_exec_timeout', 'nics',
            'owner_uuid', 'package_name', 'package_version', 'quota', 'ram',
            'resolvers', 'vcpus', 'zfs_data_compression', 'zfs_io_priority',
            'tags', 'tmpfs'
        ];

        for (i = 0; i < keys.length; i++) {
            var key = keys[i];
            if (params[key] !== undefined) {
                payload[key] = params[key];
            }
        }

        // Per OS-2520 we always want to be setting archive_on_delete in SDC
        payload['archive_on_delete'] = true;

        // If internal_metadata.set_resolvers === false, we always want
        // to leave the resolvers as empty
        if (params.internal_metadata !== undefined &&
            typeof (params.internal_metadata) === 'object' &&
            params.internal_metadata.set_resolvers === false) {
            wantResolvers = false;
        }

        // Add resolvers and routes in the order of the networks
        var resolver;
        var resolvers = [];
        var routes = {};
        for (i = 0; i <  params.nics.length; i++) {
            nic = params.nics[i];

            if (nic['resolvers'] !== undefined &&
                Array.isArray(nic['resolvers'])) {
                for (j = 0; j < nic['resolvers'].length; j++) {
                    resolver = nic['resolvers'][j];
                    if (resolvers.indexOf(resolver) === -1) {
                        resolvers.push(resolver);
                    }
                }
            }

            if (nic['routes'] !== undefined &&
                typeof (nic['routes']) === 'object') {
                for (var r in nic['routes']) {
                    if (!routes.hasOwnProperty(r)) {
                        routes[r] = nic['routes'][r];
                    }
                }
            }
        }

        if (wantResolvers) {
            payload['resolvers'] = resolvers;
        }

        if (Object.keys(routes).length !== 0) {
            payload['routes'] = routes;
        }

        if (params['brand'] === 'kvm') {
            // It is possible that no disks are present in the payload when
            // only a billing_id was passed for the provision (i.e provision
            // a VM with a package)
            var disks = params['disks'];
            if (!disks) {
                disks = [
                    { image_uuid: job.image.uuid },
                    { size: Number(job['package'].quota), refreservation: 0 }
                ];
            }
            var disk0 = disks[0];

            disk0['image_name'] = job.image['name'];
            disk0['image_size'] = job.image['image_size'];
            disks[0] = disk0;
            payload['disks'] = disks;

            ['disk_driver', 'nic_driver', 'cpu_type'].forEach(function (field) {
                if (params[field]) {
                    payload[field] = params[field];
                } else {
                    payload[field] = job.image[field];
                }
            });
        } else {
            payload['image_uuid'] = params['image_uuid'];

            if (params['filesystems'] !== undefined) {
                payload['filesystems'] = params['filesystems'];
            }
        }

        return payload;
    }

    job.params.payload = preparePayload(job.params);

    return cnapi.createVm(server, job.params.payload, function (err, task) {
        if (err) {
            return cb(err);
        } else {
            job.taskId = task.id;
            return cb(null, 'Provision queued!');
        }
    });
}



/*
 * Sets the post back execution state as failed
 */
function setPostBackFailed(job, cb) {
    job.postBackState = 'failed';
    return cb(null, 'Set post back state as failed');
}


/*
 * Cleans up some of the job properties to decrease job size to something
 * not including every CN with every machine included
 */

function reduceJobSize(job, cb) {
    job.servers = null;
    job.filteredServers = null;
    return cb(null, 'Removed servers listings');
}

var workflow = module.exports = {
    name: 'provision-' + VERSION,
    version: VERSION,
    chain: [ {
        name: 'common.validate_params',
        timeout: 10,
        retry: 1,
        body: validateParams
    }, {
        name: 'imgapi.get_image',
        timeout: 10,
        retry: 1,
        body: getImage
    }, {
        name: 'imgapi.generate_passwords',
        timeout: 10,
        retry: 1,
        body: generatePasswords,
        modules: { childProcess: 'child_process', async: 'async' }
    }, {
        name: 'ufds.get_package',
        timeout: 10,
        retry: 1,
        body: common.getPackage,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'ufds.add_customer_vm',
        timeout: 10,
        retry: 1,
        body: addCustomerVm,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'napi.get_nic_tags',
        timeout: 10,
        retry: 1,
        body: getNicTags,
        modules: { sdcClients: 'sdc-clients', async: 'async' }
    }, {
        name: 'cnapi.get_servers',
        timeout: 60,
        retry: 1,
        body: getServers,
        modules: { sdcClients: 'sdc-clients', async: 'async' }
    }, {
        name: 'cnapi.filter_servers',
        timeout: 10,
        retry: 1,
        body: filterServers,
        modules: {}
    }, {
        name: 'dapi.get_allocation',
        timeout: 120,
        retry: 1,
        body: getAllocation,
        modules: { restify: 'restify' }
    }, {
        name: 'napi.provision_nics',
        timeout: 20,
        retry: 1,
        body: common.provisionNics,
        modules: { sdcClients: 'sdc-clients', async: 'async' }
    }, {
        name: 'cnapi.provision_vm',
        timeout: 10,
        retry: 1,
        body: provision,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'cnapi.poll_task',
        timeout: 3600,
        retry: 1,
        body: common.pollTask,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'reduce_job_size',
        body: reduceJobSize,
        modules: {}
    }, {
        name: 'vmapi.check_state',
        timeout: 120,
        retry: 1,
        body: common.checkState,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'fwapi.update',
        timeout: 10,
        retry: 1,
        body: common.updateFwapi,
        modules: { restify: 'restify' }
    }],
    timeout: 3810,
    onerror: [ {
        name: 'ufds.delete_customer_vm',
        body: common.deleteCustomerVm,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'napi.cleanup_nics',
        timeout: 10,
        retry: 1,
        body: common.cleanupNics,
        modules: { sdcClients: 'sdc-clients', async: 'async' }
    }, {
        name: 'set_post_back_failed',
        body: setPostBackFailed,
        modules: {}
    }, {
        name: 'common.post_back',
        body: common.postBack,
        modules: { async: 'async', restify: 'restify', urlModule: 'url' }
    }, {
        name: 'On error',
        modules: {},
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }]
};
