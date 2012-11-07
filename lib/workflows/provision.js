/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


// This is not really needed, but javascriptlint will complain otherwise:
var sdcClients = require('sdc-clients');
var async = require('async');
var restify = require('restify');
var common = require('./job-common');

var VERSION = '7.0.0';

// make check
var dapiUrl, cnapiUrl, napiUrl, napiUsername, napiPassword;
var ufdsUrl, ufdsDn, ufdsPassword;

function validateParams(job, cb) {
    if (!dapiUrl) {
        return cb('No DAPI URL provided');
    }

    if (!napiUrl || !napiUsername || !napiPassword) {
        return cb('No NAPI parameters provided');
    }

    if (!ufdsUrl || !ufdsDn || !ufdsPassword) {
        return cb('No UFDS parameters provided');
    }

    if (!cnapiUrl) {
        return cb('No CNAPI URL provided');
    }

    if (!job.params['owner_uuid']) {
        return cb('\'owner_uuid\' is required');
    }

    if (!job.params['image_uuid']) {
        return cb('\'image_uuid\' is required');
    }

    if (!job.params.brand) {
        return cb('VM \'brand\' is required');
    }

    if (!job.params.ram) {
        return cb('VM \'ram\' is required');
    }

    if (!job.params.quota) {
        return cb('VM \'quota\' is required');
    }

    if (job.params['vm_uuid']) {
        job.params.uuid = job.params.vm_uuid;
    }

    return cb(null, 'All parameters OK!');
}



function addCustomerVm(job, cb) {
    var dn = 'vm=' + job.params['vm_uuid'] + ', uuid=' +
            job.params['owner_uuid'] + ', ou=users, o=smartdc';
    var vm = {
        objectclass: 'vm',
        ram: job.params.ram,
        quota: job.params.quota,
        uuid: job.params['vm_uuid'],
        image_uuid: job.params['image_uuid']
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
        if (job.params['image_os']) {
            vm['image_os'] = job.params['image_os'];
        }

        if (job.params['image_name']) {
            vm['image_name'] = job.params['image_name'];
        }

        if (job.params['billing_id']) {
            vm['billing_id'] = job.params['billing_id'];
        }

        return UFDS.add(dn, vm, onAddVm);
    }

    function onAddVm(err) {
        if (err) {
            return cb(err);
        }

        job.addedToUfds = true;
        return cb(null, 'Customer VM added to UFDS');
    }
}



function getNicTags(job, cb) {
    var networks = job.params.networks;
    if (!networks) {
        cb('Networks are required');
    }

    var napi = restify.createJsonClient({ url: napiUrl });
    napi.basicAuth(napiUsername, napiPassword);

    job.nicTags = [];

    async.mapSeries(networks, function (network, next) {
        var uuid;
        if (typeof (network) == 'string') {
            uuid = network;
        } else {
            uuid = network.uuid;
        }

        napi.get('/networks/' + uuid, function (err, req, res, net) {
            if (err) {
              next(err);
            } else {
              job.nicTags.push(net.nic_tag);
              next();
            }
        });
    }, function (err2) {
        if (err2) {
            cb(err2);
        } else {
            job.log.info({nicTags: job.nicTags}, 'NIC Tags retrieved');
            cb(null, 'NIC Tags retrieved');
        }
    });
}



function getServerNics(job, cb) {
    if (job.params['server_uuid']) {
        return cb(null, 'Server UUID present, no need to get NICs for servers');
    }

    var nicTags = job.nicTags;

    if (!nicTags) {
        return cb('NIC Tags are required');
    }

    var napi = restify.createJsonClient({ url: napiUrl });
    napi.basicAuth(napiUsername, napiPassword);

    job.serverUuids = [];

    var query = {
        path: '/nics',
        query: { belongs_to_type: 'server', nic_tags_provided: job.nicTags}
    };

    napi.get(query, function (err, req, res, nics) {
        if (err) {
            cb(err);
        } else {
            for (var j = 0; j < nics.length; j++) {
                var nic = nics[j];

                // Might be the case that we want 2 nics on the same network
                if (job.serverUuids.indexOf(nic['belongs_to_uuid']) == -1) {
                    job.serverUuids.push(nic['belongs_to_uuid']);
                }
            }

            /*JSSTYLED*/
            job.log.info({ serverUuids: job.serverUuids }, 'Server UUIDs retrieved');
            cb(null, 'Server UUIDs retrieved');
        }
    });

    return (null);
}



function getServers(job, cb) {
    if (job.params['server_uuid']) {
        return cb(null,
                  'Server UUID present, no need to get servers from CNAPI');
    }

    var cnapi = restify.createJsonClient({ url: cnapiUrl });
    var path = '/servers?uuids=' + job.serverUuids.join(',');

    return cnapi.get(path, function (err, req, res, servers) {
        if (err) {
            return cb(err);
        } else {
            if (Array.isArray(servers) && servers.length) {
                job.servers = servers;
                return cb(null, 'Got servers');
            } else {
                return cb(new Error('No servers found on CNAPI'));
            }
        }
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

    if (filtered.length > 0) {
        job.filteredServers = filtered;
        return cb(null, 'Filtered servers with NIC Tag requirements');
    } else {
        return cb('None of the servers meet the NIC Tag requirements');
    }
}



function getAllocation(job, cb) {
    if (job.params['server_uuid']) {
        cb(null, 'Server UUID present, no need to get allocation from DAPI');
        return;
    }

    var dapi = restify.createJsonClient({ url: dapiUrl });

    var payload = {
        servers: job.filteredServers,
        vm: { ram: job.params.ram, nic_tags: job.nicTags }
    };

    job.log.info({ dapiPayload: payload }, 'Payload sent to DAPI');

    dapi.post('/allocation', payload, function (err, req, res, server) {
        if (err) {
            cb(err);
        } else {
            job.params['server_uuid'] = server.uuid;
            cb(null, 'Server allocated!');
        }
    });
}



function getNICs(job, cb) {
    var networks = job.params.networks;
    if (!networks) {
        cb('Networks are required');
    }

    var napi = restify.createJsonClient({ url: napiUrl });
    napi.basicAuth(napiUsername, napiPassword);
    job.params.nics = [];

    async.mapSeries(networks, function (network, next) {
        // Legacy
        var uuid, ip;
        if (typeof (network) == 'string') {
            uuid = network;
            ip = null;
        } else {
            uuid = network.uuid;
            ip = network.ip;
        }

        var path = '/networks/' + uuid + '/nics';
        var params = {
            owner_uuid: job.params.owner_uuid,
            belongs_to_uuid: job.params.uuid,
            belongs_to_type: 'zone'
        };
        if (ip) {
            params.ip = ip;
        }

        napi.post(path, params, function (err, req, res, nic) {
            if (err) {
                next(err);
            } else {
                job.params.nics.push(nic);
                next();
            }
        });
    }, function (err2) {
        if (err2) {
            cb(err2);
        } else {
            job.log.info({nics: job.params.nics}, 'NICs allocated');
            cb(null, 'NICs allocated!');
        }
      });
}



function provision(job, cb) {
    var cnapi = restify.createJsonClient({ url: cnapiUrl });
    var endpoint = '/servers/' + job.params.server_uuid + '/vms';
    job.params.jobid = job.uuid;

    // autoboot=false means we want the machine to not to boot after provision
    if (job.params.autoboot === false || job.params.autoboot === 'false') {
        job.expects = 'stopped';
    } else {
        job.expects = 'running';
    }

    return cnapi.post(endpoint, job.params, function (err, req, res, task) {
      if (err) {
          return cb(err);
      } else {
          job.taskId = task.id;
          return cb(null, 'Provision queued!');
      }
    });
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
        name: 'ufds.add_customer_vm',
        timeout: 10,
        retry: 3,
        body: addCustomerVm
    }, {
        name: 'napi.get_nic_tags',
        timeout: 10,
        retry: 1,
        body: getNicTags
    }, {
        name: 'napi.get_server_nics',
        timeout: 10,
        retry: 1,
        body: getServerNics
    }, {
        name: 'cnapi.get_servers',
        timeout: 10,
        retry: 1,
        body: getServers
    }, {
        name: 'cnapi.filter_servers',
        timeout: 10,
        retry: 1,
        body: filterServers
    }, {
        name: 'dapi.get_allocation',
        timeout: 10,
        retry: 1,
        body: getAllocation
    }, {
        name: 'napi.provision_nics',
        timeout: 10,
        retry: 1,
        body: getNICs
    }, {
        name: 'cnapi.provision_vm',
        timeout: 10,
        retry: 1,
        body: provision
    }, {
        name: 'cnapi.poll_task',
        timeout: 120,
        retry: 1,
        body: common.pollTask
    }, {
        name: 'vmapi.check_state',
        timeout: 60,
        retry: 1,
        body: common.checkState
    }, {
        name: 'vmapi.check_propagated',
        timeout: 60,
        retry: 1,
        body: common.checkPropagated
    }],
    timeout: 330,
    onerror: [{
        name: 'ufds.delete_customer_vm',
        body: common.deleteCustomerVm
    }, {
        name: 'On error',
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }]
};
