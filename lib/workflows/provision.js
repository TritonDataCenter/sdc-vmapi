/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


// This is not really needed, but javascriptlint will complain otherwise:
var sdcClients = require('sdc-clients');
var uuid = require('node-uuid');
var restify = require('restify');

function validateParams(job, cb) {
    if (!job.params.dapiUrl || !job.params.dapiUsername ||
        !job.params.dapiPassword)
        return cb('No DAPI parameters provided');

    if (!job.params.cnapiUrl)
        return cb('No CNAPI URL provided');

    if (!job.params.owner_uuid)
        return cb('Owner UUID is required');

    if (!job.params.dataset_uuid)
        return cb('Dataset UUID is required');

    if (!job.params.brand)
        return cb('Machine brand is required');

    if (!job.params.ram)
        return cb('Machine RAM is required');

    if (job.params.muuid) {
        job.params.uuid = job.params.muuid;
        delete job.params.muuid;
    }

    return cb(null, 'All parameters OK!');
}



function getServers(job, cb) {
    var cnapi = restify.createJsonClient({ url: job.params.cnapiUrl });

    return cnapi.get('/servers', function (err, req, res, servers) {
        if (err) {
            return cb(new Error(err.name + ': ' + err.body.message));
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
    var dapi = restify.createJsonClient({ url: job.params.dapiUrl });

    dapi.basicAuth(job.params.dapiUsername, job.params.dapiPassword);

    var serversJSON = { servers: JSON.stringify(job.servers) };

    return dapi.post('/allocation', serversJSON,
      function (err, req, res, server) {
          if (err) {
              return cb(new Error(err.name + ': ' + err.body.message));
          } else {
              job.params.server_uuid = server.uuid;
              return cb(null, 'Server allocated!');
          }
    });
}



function getNICs(job, cb) {
    var networks = job.params.networks;

    if (networks && Array.isArray(networks)) {
        if (!job.params.napiUrl || !job.params.napiUsername ||
            !job.params.napiPassword)
            return cb('No NAPI parameters provided');

        var napi = restify.createJsonClient({ url: job.params.napiUrl });
        napi.basicAuth(job.params.napiUsername, job.params.napiPassword);

        job.params.nics = [];
        var params = {
            owner_uuid: job.params.owner_uuid,
            belongs_to_uuid: job.params.uuid,
            belongs_to_type: 'zone'
        };

        for (var i = 0; i < networks.length; i++) {
            var path = '/networks/' + networks[i] + '/nics';
            napi.post(path, params, function (err, req, res, nic) {
                  if (err) {
                      return cb(new Error(err.name + ': ' + err.body.message));
                  } else {
                      job.params.nics.push(nic);

                      if (job.params.nics.length == networks.length)
                        return cb(null, 'NICs allocated!');
                  }
            });
        }
    } else {
        return cb(null, 'No networks provided, that\'s OK');
    }
}



function provision(job, cb) {
    var cnapi = restify.createJsonClient({ url: job.params.cnapiUrl });
    var endpoint = '/servers/' + job.params.server_uuid + '/vms';
    job.params.jobid = job.uuid;

    return cnapi.post(endpoint, job.params, function (err, req, res, task) {
      if (err) {
          return cb(err.name + ': ' + err.body.message);
      } else {
          job.params.taskId = task.id;
          return cb(null, 'Provision queued!');
      }
    });
}



var workflow = module.exports = {
    name: 'provision-' + uuid(),
    chain: [ {
        name: 'Validate parameters',
        timeout: 30,
        retry: 1,
        body: validateParams
    }, {
        name: 'Get servers',
        timeout: 30,
        retry: 1,
        body: getServers
    }, {
        name: 'Get allocation',
        timeout: 30,
        retry: 1,
        body: getAllocation
    }, {
        name: 'Get NICs',
        timeout: 30,
        retry: 1,
        body: getNICs
    }, {
        name: 'Provision',
        timeout: 240,
        retry: 1,
        body: provision
    }],
    timeout: 180,
    onerror: [ {
        name: 'On error',
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }]
};
