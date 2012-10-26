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

function validateParams(job, cb) {
    if (!dapiUrl)
        return cb('No DAPI URL provided');

    if (!napiUrl || !napiUsername || !napiPassword)
        return cb('No NAPI parameters provided');

    if (!cnapiUrl)
        return cb('No CNAPI URL provided');

    if (!job.params['owner_uuid'])
        return cb('\'owner_uuid\' is required');

    if (!job.params['image_uuid'])
        return cb('\'image_uuid\' is required');

    if (!job.params.brand)
        return cb('VM \'brand\' is required');

    if (!job.params.ram)
        return cb('VM \'ram\' is required');

    if (job.params['vm_uuid']) {
        job.params.uuid = job.params.vm_uuid;
    }

    return cb(null, 'All parameters OK!');
}



function getNicTags(job, cb) {
    var networks = job.params.networks;
    if (!networks) {
        cb('Networks are required');
    }

    var napi = restify.createJsonClient({ url: napiUrl });
    napi.basicAuth(napiUsername, napiPassword);

    job.nic_tags = [];

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
              job.nic_tags.push(net.nic_tag);
              next();
            }
        });
    }, function (err2) {
        if (err2) {
            cb(err2);
        } else {
            job.log.info({nic_tags: job.nic_tags}, 'NIC Tags retrieved');
            cb(null, 'NIC Tags retrieved');
        }
    });
}



// function getServerNics(job, cb) {
//     var nic_tags = job.nic_tags;

//     if (!nic_tags) {
//         return cb('NIC Tags are required');
//     }

//     var napi = restify.createJsonClient({ url: napiUrl });
//     napi.basicAuth(napiUsername, napiPassword);

//     job.server_uuids = [];
//     var added = 0;

//     for (var i = 0; i < nic_tags.length; i++) {
//         var query = {
//             path: '/nics',
//             query: { belongs_to_type: 'server', nic_tag: nic_tags[i] }
//         };
//         napi.get(query, function (err, req, res, nics) {
//             if (err) {
//                 return cb(err);
//             } else {
//                 for (var j = 0; j < nics.length) {
//                     var nic = nics[j];

//                 // Might be the case that we want 2 nics on the same network
//                     if (job.server_uuids.indexOf(nic.belongs_to_uuid) == -1)
//                       job.server_uuids.push(nic.belongs_to_uuid);
//                 }

//                 added++;

//                 if (added == nic_tags.length)
//                 return cb(null, 'Server UUIDs retrieved!');
//             }
//         });
//     }
// }



function getServers(job, cb) {
    if (job.params['server_uuid']) {
        return cb(null,
                  'Server UUID present, no need to get servers from CNAPI');
    }

    var cnapi = restify.createJsonClient({ url: cnapiUrl });

    return cnapi.get('/servers', function (err, req, res, servers) {
        if (err) {
            return cb(err);
        } else {
            if (Array.isArray(servers) && servers.length) {
                job.servers = servers;
                return cb(null, 'Got servers!');
            } else {
                return cb(new Error('No servers found on CNAPI'));
            }
        }
    });
}



function getAllocation(job, cb) {
    if (job.params['server_uuid']) {
        cb(null, 'Server UUID present, no need to get allocation from DAPI');
        return;
    }

    var dapi = restify.createJsonClient({ url: dapiUrl });

    var payload = {
        servers: job.servers,
        vm: { ram: job.params.ram }
    };

    dapi.post('/allocation', payload,
      function (err, req, res, server) {
          if (err) {
              cb(err);
          } else {
              job.params.server_uuid = server.uuid;
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
    job.expects = 'running';

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
        name: 'cnapi.get_servers',
        timeout: 10,
        retry: 1,
        body: getServers
    }, {
        name: 'napi.get_nic_tags',
        timeout: 10,
        retry: 1,
        body: getNicTags
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
    timeout: 300,
    onerror: [ {
        name: 'On error',
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }]
};
