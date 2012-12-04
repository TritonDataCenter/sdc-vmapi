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
var fwCommon = require('./fw-common');

var VERSION = '7.0.0';

// make check
var dapiUrl, cnapiUrl, fwapiUrl, napiUrl, napiUsername, napiPassword;
var ufdsUrl, ufdsDn, ufdsPassword;


/*
 * Validates that the needed provision parameters are present
 */
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

    if (!fwapiUrl) {
        return cb('No FWAPI URL provided');
    }

    if (!imgapiUrl) {
        return cb('No IMGAPI URL provided');
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
        job.params.uuid = job.params['vm_uuid'];
    }

    return cb(null, 'All parameters OK!');
}



/*
 * Gets the Image that corresponds to the image_uuid parameter
 */
function getImage(job, cb) {
    var imgapi = restify.createJsonClient({ url: imgapiUrl });
    var path = '/images/' + job.params['image_uuid'];

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
    if (job.image['generate_passwords'] !== true) {
        return cb(null, 'No need to generate passwords for image');
    }

    if (job.image.users === undefined || !Array.isArray(job.image.users)) {
        return cb('Image has generate_passwords=true but no users found');
    }

    var users = job.image.users;
    var cm = job.params['customer_metadata'];
    var credentials;

    // - If you didn't pass metadata, initialize it
    // - If you passed metadata without credentials, initialize it
    // - If you passed metadata with malformed credentials, initialize it
    // - If you passed metadata with valid credentials, use it
    if (cm === undefined) {
        cm = {};
        credentials = {};
    } else {
        /*JSSTYLED*/
        if (cm.credentials !== undefined && typeof (cm.credentials) === 'string') {
            try {
                // Credentials should be a JSON string since metadata only
                // accepts string/numeric/boolean values
                credentials = JSON.parse(cm.credentials);
            } catch (e) {
                credentials = {};
            }
        } else {
            credentials = {};
        }
    }

    for (var i = 0; i < users.length; i++) {
        var user = users[i].name;
        if (credentials[user + '_pw'] ===  undefined) {
            job.log.info('Im here generating credential ', user);
            credentials[user + '_pw'] = randomPassword(10);
        }
    }

    cm.credentials = JSON.stringify(credentials);
    job.params['customer_metadata'] = cm;
    return cb(null, 'Passwords generated for Image');


    // Random password generator
    function randomPassword(length) {
        if (length === undefined) {
            length = 10;
        }

        /*JSSTYLED*/
        var chars = "ABCDEFGHJKLMNPQRSTUVWXTZabcdefghklmnpqrstuvwxyz23456789-?_#<>";
        var randomstring = '';
        var charCount = 0;
        var numCount = 0;
        var rnum;

        for (var i = 0; i < length; i++) {
            if ((Math.floor(Math.random() * 2) === 0) && numCount < 3 ||
                charCount >= 5) {
                rnum = Math.floor(Math.random() * 10);
                randomstring += rnum;
                numCount += 1;
            } else {
                rnum = Math.floor(Math.random() * chars.length);
                randomstring += chars.substring(rnum,rnum+1);
                charCount += 1;
            }
        }

        return randomstring;
    }
}



/*
 * Adds a custom vmusage object to UFDS. This object is used by the cloudapi
 * limits plugin in order to determine if a customer should be able to provision
 * more machines
 */
function addCustomerVm(job, cb) {
    var dn = 'vm=' + job.params['vm_uuid'] + ', uuid=' +
            job.params['owner_uuid'] + ', ou=users, o=smartdc';
    var vm = {
        objectclass: 'vmusage',
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
        return cb(null, 'Customer VM usage added to UFDS');
    }
}



/*
 * Gets a list of NIC tags given the network uuids provided
 */
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



/*
 * Gets a list of server UUIDs given the NIC tags specified by the networks in
 * the provision request. All of the NICs that NAPI returns must belong to a
 * server, that's why the belongs_to_type parameter is present. With the
 * resulting NICs list we map that to a list of server_uuids that we use to call
 * CNAPI
 */
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



/*
 * Gets a list of servers from CNAPI. The job.serverUuids parameter must be
 * present. Note that if you pass params['server_uuid'], this function will be
 * skipped because you are already specifying the server you want to provision
 * to
 */
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



/*
 * Provisions a list of NICs for the soon to be provisioned machine. The
 * networks list can contain a not null ip attribute on each object, which
 * denotes that we want to allocate that given IP for the correspondant network.
 * This task should be executed after DAPI has allocated a server
 */
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



/*
 * Calls the provision endpoint on CNAPI. This function is very similar to
 * common.zoneAction. Here, we also make sure if we are trying to provision an
 * autoboot machine, in which case the job.expects attribute value should be
 * stopped (and then common.checkState waits for the machine to be stopped)
 */
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
        // name: 'imgapi.get_image',
        // timeout: 10,
        // retry: 1,
        // body: getImage
    // }, {
        // name: 'imgapi.generate_passwords',
        // timeout: 10,
        // retry: 1,
        // body: generatePasswords
    // }, {
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
        name: 'fwapi.get_firewall_data',
        timeout: 10,
        retry: 1,
        body: fwCommon.resolveFirewallData
    }, {
        name: 'vmapi.get_firewall_targets',
        timeout: 10,
        retry: 1,
        body: fwCommon.getVMs
    }, {
        name: 'fwapi.populate_firewall_data',
        timeout: 10,
        retry: 1,
        body: fwCommon.populateFirewallData
    }, {
        name: 'cnapi.provision_vm',
        timeout: 10,
        retry: 1,
        body: provision
    }, {
        name: 'cnapi.fw_update',
        timeout: 120,
        retry: 1,
        body: fwCommon.cnapiFwUpdate
    }, {
        name: 'cnapi.poll_task',
        timeout: 120,
        retry: 1,
        body: common.pollTask
    }, {
        name: 'cnapi.fw_poll',
        timeout: 120,
        retry: 1,
        body: fwCommon.cnapiPollTasks
    }, {
        name: 'vmapi.check_state',
        timeout: 120,
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
