/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * FWAPI: workflow shared functions
 */

// These must match the names available in the workflow VM:
var async = require('async');
var restify = require('restify');
var sdcClients = require('sdc-clients');
var verror = require('verror');



// --- Globals



// Make jslint happy:
var cnapiUrl;
var fwapiUrl;
var vmapiUrl;



// --- Exports



/**
 * Start a provisioner task with CNAPI on each of the servers to update
 * the firewall data
 */
function cnapiFwUpdate(job, callback) {
  if (!job.params.fwapiServers || job.params.fwapiServers.length === 0) {
    return callback(null, 'No remote servers to update');
  }

  var cnapi = new sdcClients.CNAPI({ url: cnapiUrl });
  var matchingVMs = job.params.fwapiMatchingVMs || [];
  job.params.taskIDs = [];

  return async.forEach(job.params.fwapiServers, function (uuid, cb) {
    var endpoint = '/servers/' + uuid + '/fw/update';
    var firewall = {
      jobid: job.uuid
      // XXX rules: [ job.params.rule ],
    };

    var remoteVMs = matchingVMs.filter(function (rvm) {
      return (rvm.server_uuid != uuid);
    });

    if (remoteVMs.length) {
      firewall.remoteVMs = remoteVMs;
    }

    job.log.debug(firewall, 'Updating rules on server "%s"', uuid);
    return cnapi.post(endpoint, firewall, function (err, task) {
      if (err) {
        return cb(err);
      }
      job.log.debug(task, 'Server "%s": task', uuid);

      job.params.taskIDs.push({ server_uuid: uuid, task_id: task.id});
      return cb(null);
    });
  }, function (err) {
    if (err) {
      return callback(err);
    }

    return callback(null, 'Started update on servers: '
      + job.params.fwapiServers.join(', '));
  });
}


/**
 * Poll CNAPI for each of the fw tasks sent off
 */
function cnapiPollTasks(job, callback) {
  if (!job.params.fwapiServers || job.params.fwapiServers.length === 0) {
    return callback(null, 'No remote servers to poll');
  }

  var cnapi = new sdcClients.CNAPI({ url: cnapiUrl });

  job.params.taskSuccesses = [];
  job.params.taskFailures = [];

  return async.forEach(job.params.taskIDs, function (detail, cb) {
    var uuid = detail.server_uuid;
    var taskID = detail.task_id;
    var intervalID = setInterval(interval, 1000);

    function interval() {
      cnapi.getTask(taskID, function onCnapi(err, task) {
        if (err) {
          clearInterval(intervalID);
          return cb(err);
        }

        job.log.debug(task, 'retrieved task for server "%s"', uuid);
        if (task.status == 'failure') {
          clearInterval(intervalID);
          job.params.taskFailures.push(taskID);
          return cb(new verror.VError(
            'Job "%s" failed for server "%s"', taskID, uuid));
        }

        if (task.status == 'complete') {
          clearInterval(intervalID);
          job.params.taskSuccesses.push(taskID);
          return cb(null);
        }
      });
    }
  }, function (err) {
    if (err) {
      return callback(err);
    }

    return callback(null, 'All server tasks returned successfully');
  });
}


/**
 * Get VMs from VMAPI
 *
 * @param job {Object} :
 * - params {Object} : must specify at least one of tags, vms:
 *   - tags {Array} : tag names to search for
 *   - vms {Array} : VM UUIDs to search for
 * @param callback {Function} : `f(err, successMessage)`
 *
 * Once function is complete, the following will be stored in job.params:
 * - ipData {Object} :
 *   - machines {Object} : mapping of machines to IP addresses
 *   - tags {Object} : mapping of tags to IP addresses
 * - servers {Array} : server UUIDs that contain the matching VMs
 */
function getVMs(job, callback) {
  if (!job.params.hasOwnProperty('fwapiTags')
      && !job.params.hasOwnProperty('fwapiVMs')) {
    return callback(null, 'No tags or VMs to get');
  }
  var tags = job.params.fwapiTags || [];
  var vms = job.params.fwapiVMs || [];
  if (tags.length === 0 && vms.length === 0) {
    return callback(null, 'No tags or VMs to get');
  }

  var left = {
    tags: tags.reduce(function (acc, t) { acc[t] = 1; return acc; }, {}),
    vms:  vms.reduce(function (acc, vm) { acc[vm] = 1; return acc; }, {})
  };

  //var vmapi = new sdcClients.VMAPI(vmapiOptions);
  var vmapi = restify.createJsonClient({ url: vmapiUrl });
  return vmapi.get('/vms', function (err, req, res, vmList) {
    if (err) {
      return callback(err);
    }

    var remoteVMs = [];
    var servers = {};

    if (job.params.task && job.params.task === 'provision') {
      vmList.push({
        firewall_enabled: job.params.firewall_enabled,
        nics: job.params.nics,
        owner_uuid: job.params.owner_uuid,
        server_uuid: job.params.server_uuid,
        tags: job.params.tags || { },
        uuid: job.params.uuid
      });
    }

    vmList.forEach(function (vm) {
      var rvm = {
        enabled: vm.firewall_enabled ? true : false,
        ips: vm.nics.map(function (n) { return n.ip; }),
        owner_uuid: vm.owner_uuid,
        server_uuid: vm.server_uuid,
        tags: { },
        uuid: vm.uuid
      };

      for (var k in vm.tags) {
        rvm.tags[k] = vm.tags[k];
      }

      tags.forEach(function (tag) {
        if (vm.tags.hasOwnProperty(tag)) {
          remoteVMs.push(rvm);
          servers[vm.server_uuid] = 1;
          delete left.tags[tag];
        }
      });

      vms.forEach(function (uuid) {
        if (vm.uuid == uuid) {
          remoteVMs.push(rvm);
          servers[vm.server_uuid] = 1;
          delete left.vms[uuid];
        }
      });
    });

    var errs = [];
    var vmsLeft = Object.keys(left.vms);
    var tagsLeft = Object.keys(left.tags);

    if (tagsLeft.length !== 0) {
      errs.push(new verror.VError('Unknown tag%s: %s',
        tagsLeft.length == 0 ? '' : 's',
        tagsLeft.join(', ')));
    }
    if (vmsLeft.length !== 0) {
      errs.push(new verror.VError('Unknown VM%s: %s',
        vmsLeft.length == 0 ? '' : 's',
        vmsLeft.join(', ')));
    }

    if (errs.length !== 0) {
      return callback(new verror.MultiError(errs));
    }

    job.params.fwapiMatchingVMs = remoteVMs;
    job.params.fwapiServers = Object.keys(servers);

    job.log.info({ matchingVMs: remoteVMs, servers: job.params.fwapiServers },
      'firewall VM data retrieved');
    return callback(null, 'firewall VM data retrieved');
  });
}


/*
 * Populates firewall data for provisioning
 */
function populateFirewallData(job, cb) {
  if (!job.params.fwapiResolveData) {
    return cb(null, 'No firewall data to populate');
  }

  var resolved = job.params.fwapiResolveData;
  var firewall = {};
  var haveData = false;
  var matchingVMs = job.params.fwapiMatchingVMs || [];
  var msg;
  var server_uuid = job.params.server_uuid;

  if (resolved.rules && resolved.rules.length !== 0) {
    firewall.rules = resolved.rules;
    haveData = true;
  }

  if (matchingVMs.length !== 0) {
    var remoteVMs = matchingVMs.filter(function (rvm) {
      return (rvm.server_uuid != server_uuid);
    });

    if (remoteVMs.length !== 0) {
      firewall.remoteVMs = remoteVMs;
      haveData = true;
    }
  }

  // Don't bother sending a separate provisioner message for the server
  // the VM is going to be provisioned on: it will have this data already
  if (job.params.fwapiServers && job.params.fwapiServers.length !== 0) {
    job.params.fwapiServers = job.params.fwapiServers.filter(function (u) {
      return (u !== server_uuid);
    });
  }

  if (haveData) {
    job.params.firewall = firewall;
    msg = 'Added firewall data to payload';
  } else {
    msg = 'No firewall data added to payload';
  }

  job.log.debug(firewall, msg);
  return cb(null, msg);
}


/*
 * Gets firewall data from FWAPI
 */
function resolveFirewallData(job, cb) {
    var fwapi = restify.createJsonClient({ url: fwapiUrl });
    var ips = job.params.nics.map(function (n) { return n.ip; });
    var tags = job.params.tags || {};

    var params = {
        ips: ips,
        owner_uuid: job.params.owner_uuid,
        tags: tags,
        vms: [ job.params.uuid ]
    };

    return fwapi.post('/resolve', params, function (err, req, res, firewall) {
        if (err) {
            return cb(err);
        } else {
            job.params.fwapiResolveData = firewall;
            job.params.fwapiVMs = firewall.vms || [];
            job.params.fwapiTags = firewall.tags || [];
            return cb(null, 'Firewall data retrieved');
        }
    });
}



module.exports = {
  cnapiFwUpdate: cnapiFwUpdate,
  cnapiPollTasks: cnapiPollTasks,
  getVMs: getVMs,
  populateFirewallData: populateFirewallData,
  resolveFirewallData: resolveFirewallData
};
