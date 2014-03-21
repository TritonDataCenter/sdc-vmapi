/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var async = require('async');
var common = require('./job-common');
var VERSION = '7.0.4';


/*
 * Sets up a CNAPI VM action request. Take a look at common.zoneAction. Here you
 * can set parameters such as:
 * - request endpoint (usually the VM endpoint)
 * - jobid (so CNAPI can post status updates back to the job info object)
 * - requestMethod
 * - expects (if you want to check a specific running status of the machine)
 */
function setupRequest(job, cb) {
    job.endpoint = '/servers/' +
                   job.params['server_uuid'] + '/vms/' +
                   job.params['vm_uuid'] + '/update';
    job.params.jobid = job.uuid;
    job.requestMethod = 'post';

    return cb(null, 'Request has been setup!');
}


/*
 * Get server object so we can check if it has the corresponding NIC tags
 */
function getServerNicTags(job, cb) {
    var cnapi = new sdcClients.CNAPI({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    // Goes inside the "NIC Names" array and extracts the NIC Tags for each NIC
    function mapNics(object) {
        var nics = [];

        for (var key in object) {
            var subNics = object[key]['NIC Names'];
            nics = nics.concat(subNics);
        }

        return nics;
    }

    return cnapi.getServer(job.params.server_uuid, function (err, server) {
        if (err) {
            return cb(err);
        } else {
            job.serverNicTags = mapNics(server.sysinfo['Network Interfaces']);
            return cb(null, 'Server NIC tags retrieved');
        }
    });
}



/*
 * Checks that the server has the NIC tags for every network that was passed
 */
function checkServerNicTags(job, cb) {
    var napi = new sdcClients.NAPI({
        url: napiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });
    var networks = job.params.networks;

    async.mapSeries(networks, function (network, next) {
        napi.getNetwork(network.uuid, function (err, net) {
            if (err) {
                next(err);
            } else {
                if (job.serverNicTags.indexOf(net['nic_tag']) === -1) {
                    var msg = 'Server does not have NIC tag: ' + net['nic_tag'];
                    return next(new Error(msg));
                } else {
                    return next();
                }
            }
        });
    }, function (err) {
        if (err) {
            cb(err);
        } else {
            cb(null, 'Server has all the required NIC tags');
        }
    });
}


var workflow = module.exports = {
    name: 'add-nics-' + VERSION,
    version: VERSION,
    chain: [ {
        name: 'common.validate_params',
        timeout: 10,
        retry: 1,
        body: common.validateForZoneAction,
        modules: {}
    }, {
        name: 'common.setup_request',
        timeout: 10,
        retry: 1,
        body: setupRequest,
        modules: {}
    }, {
        name: 'napi.validate_networks',
        timeout: 10,
        retry: 1,
        body: common.validateNetworks,
        modules: { sdcClients: 'sdc-clients', async: 'async' }
    }, {
        name: 'cnapi.get_server',
        timeout: 10,
        retry: 1,
        body: getServerNicTags,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'napi.check_server_nic_tags',
        timeout: 10,
        retry: 1,
        body: checkServerNicTags,
        modules: { async: 'async', sdcClients: 'sdc-clients' }
    }, {
        name: 'napi.provision_nics',
        timeout: 20,
        retry: 1,
        body: common.addNics,
        modules: { async: 'async', sdcClients: 'sdc-clients' }
    }, {
        name: 'common.update_network_params',
        timeout: 10,
        retry: 1,
        body: common.updateNetworkParams,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'cnapi.update_vm',
        timeout: 10,
        retry: 1,
        body: common.zoneAction,
        modules: { restify: 'restify' }
    }, {
        name: 'cnapi.poll_task',
        timeout: 120,
        retry: 1,
        body: common.pollTask,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'vmapi.check_updated',
        timeout: 90,
        retry: 1,
        body: common.checkUpdated,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'fwapi.update',
        timeout: 10,
        retry: 1,
        body: common.updateFwapi,
        modules: { sdcClients: 'sdc-clients' }
    }],
    timeout: 300,
    onerror: [ {
        name: 'napi.cleanup_nics',
        timeout: 10,
        retry: 1,
        body: common.cleanupNics,
        modules: { sdcClients: 'sdc-clients', async: 'async' }
    }, {
        name: 'On error',
        modules: {},
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }]
};
