/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var restify = require('restify');
var async = require('async');


/*
 * Validates that the request can be used to call CNAPI, i.e. that the cnapiUrl
 * and vm_uuid parameters are present
 */
function validateForZoneAction(job, cb) {
    if (!cnapiUrl) {
        cb('No CNAPI URL provided');
        return;
    }

    if (!job.params['vm_uuid']) {
        cb('VM UUID is required');
        return;
    }

    cb(null, 'All parameters OK!');
}



/*
 * General purpose function to call a CNAPI endpoint. endpoint and requestMethod
 * are required. This function will post the job params object as params for the
 * CNAPI request. Additionally, this function will set a taskId property in the
 * job object so you can optionally poll the status of the task with pollTask
 */
function zoneAction(job, cb) {
    if (job.params['skip_boot']) {
        cb(null, 'Skipping zoneAction');
        return;
    }

    if (!job.endpoint) {
        cb('No CNAPI endpoint provided');
        return;
    }

    if (!job.requestMethod) {
        cb('No HTTP request method provided');
        return;
    }

    // Not using sdc-clients to allow calling generic POST actions without
    // explicitly saying: startVm, stopVm, etc
    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    function callback(err, req, res, task) {
        if (err) {
            cb(err);
        } else {
            job.taskId = task.id;
            cb(null, 'Task queued to CNAPI!');
        }
    }

    if (job.requestMethod == 'post') {
        cnapi.post(job.endpoint, job.params, callback);
    } else if (job.requestMethod == 'put') {
        cnapi.put(job.endpoint, job.params, callback);
    } else if (job.requestMethod == 'del') {
        cnapi.del(job.endpoint, callback);
    } else {
        cb('Unsupported requestMethod: "' + job.requestMethod + '"');
    }
}



/*
 * Polls the status of a CNAPI task. The two possible final states of a task
 * are failure and completed. taskId is required for this task, so this function
 * is commonly used in conjunction with zoneAction
 */
function pollTask(job, cb) {
    if (job.params['skip_boot']) {
        cb(null, 'Skipping pollTask');
        return;
    }

    if (!job.taskId) {
        cb('No taskId provided');
        return;
    }

    if (!cnapiUrl) {
        cb('No CNAPI URL provided');
        return;
    }

    var cnapi = new sdcClients.CNAPI({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    // We have to poll the task until it completes. Ensure the timeout is
    // big enough so tasks end on time
    var intervalId = setInterval(interval, 1000);

    function interval() {
        function onCnapi(err, task) {
            if (err) {
                cb(err);
            } else {
                if (task.status == 'failure') {
                    clearInterval(intervalId);
                    cb(new Error(getErrorMesage(task)));

                } else if (task.status == 'complete') {
                    clearInterval(intervalId);
                    // After the provision succeeds it's up to the operator to
                    // check if the timeout is something that went wrong after
                    // the fact (heartbeater, fwapi issues). In this case we
                    // don't want to clean up NICs and UFDS usage because the
                    // VM was already physically created
                    job.cleanupOnTimeout = false;
                    cb(null, 'Job succeeded!');
                }
            }
        }

        cnapi.getTask(job.taskId, onCnapi);
    }

    function getErrorMesage(task) {
        var message;
        var details = [];

        if (task.history !== undefined && task.history.length) {
            for (var i = 0; i < task.history.length; i++) {
                var event = task.history[i];
                if (event.name && event.name === 'error' && event.event &&
                    event.event.error) {
                    var err = event.event.error;
                    if (typeof (err) === 'string') {
                        message = err;
                        if (event.event.details && event.event.details.error) {
                            message += ', ' + event.event.details.error;
                        }
                    } else {
                        message = err.message;
                    }
                } else if (event.name && event.name === 'finish' &&
                    event.event && event.event.log && event.event.log.length) {
                    for (var j = 0; j < event.event.log.length; j++) {
                        var logEvent = event.event.log[j];
                        if (logEvent.level && logEvent.level === 'error') {
                            details.push(logEvent.message);
                        }
                    }
                }
            }
        }

        // Apparently the task doesn't have any message for us...
        if (message === undefined) {
            message = 'Unexpected error occured';
        } else if (details.length) {
            message += ': ' + details.join(', ');
        }

        return message;
    }
}



/*
 * Checks (polls) the state of a machine in VMAPI. It is used for provisions and
 * VM actions such as reboot and shutdown. This task will only succeed if the VM
 * reaches the expected state, which can be passed as job.expects on a previous
 * task. vm_uuid and vmapiUrl are also required
 */
function checkState(job, cb) {
    if (job.params['skip_boot']) {
        cb(null, 'Skipping checkState');
        return;
    }

    // For now don't fail the job if this parameter is not present
    if (!job.expects) {
        cb(null, 'No \'expects\' state parameter provided');
        return;
    }

    if (!job.params['vm_uuid']) {
        cb('No VM UUID provided');
        return;
    }

    if (!vmapiUrl) {
        cb('No VMAPI URL provided');
        return;
    }

    var vmapi = new sdcClients.VMAPI({
        url: vmapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    // Poll the VM until we reach to the desired state, otherwise the task
    // timeout will fail the job, which is what we want
    var intervalId = setInterval(interval, 1000);

    function interval() {
        vmapi.getVm({ uuid: job.params['vm_uuid'] }, onVmapi);

        function onVmapi(err, vm, req, res) {
            // Provision tasks can return 404 when machine has not showed up
            if (res && res.statusCode == 404 &&
                job.params.task == 'provision') {
                return;
            } else if (err) {
                clearInterval(intervalId);
                cb(err);
            } else {
                if (vm.state == job.expects) {
                    clearInterval(intervalId);
                    cb(null, 'VM is now ' + job.expects);
                }
            }
            return;
        }
    }
}



/*
 * Checks (polls) that the machine has been updated at all. When any of the VM
 * properties are updated (such as ram or metadata), the last_modified timestamp
 * of the VM changes. This let us poll the VM endpoint until the changes on its
 * properties have been propagated
 */
function checkUpdated(job, cb) {
    if (!job.params['vm_uuid']) {
        cb('No VM UUID provided');
        return;
    }

    if (!vmapiUrl) {
        cb('No VMAPI URL provided');
        return;
    }

    if (!job.params['last_modified']) {
        cb('No VM last_modified timestamp provided');
        return;
    }

    var oldDate = new Date(job.params['last_modified']);
    var vmapi = new sdcClients.VMAPI({
        url: vmapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });
    // Poll the VM until its last_modified timestamp has changed
    var intervalId = setInterval(interval, 1000);

    function interval() {
        vmapi.listVms({ uuid: job.params['vm_uuid'] }, onVmapi);

        function onVmapi(err, vms, req, res) {
            if (err) {
                clearInterval(intervalId);
                cb(err);
            } else if (vms.length && (vms[0].uuid == job.params['vm_uuid'])) {
                var newDate = new Date(vms[0]['last_modified']);

                if (newDate > oldDate) {
                    clearInterval(intervalId);
                    cb(null, 'VM data has been updated');
                }
            }
        }
    }
}



/*
 * Deletes a custom vmusage object from UFDS. This object is used by the
 * cloudapi limits plugin in order to determine if a customer should be able to
 * provision more machines
 */
function deleteCustomerVm(job, cb) {
    // Unless it is explicitly false, meaning that cnapi.pollTask succeeded
    if (job.cleanupOnTimeout === false) {
        return cb(null, 'cleanupOnTimeout was set to false');
    }

    // This allows the provisioning task to know if the customer was added to
    // UFDS already before the provision failed so we don't try to destroy a
    // customer that doesn't exist
    if (!job.addedToUfds) {
        return cb(null, 'Customer doesn\'t exist on UFDS');
    }

    var dn = 'vm=' + job.params['vm_uuid'] + ', uuid=' +
            job.params['owner_uuid'] + ', ou=users, o=smartdc';

    var ufdsOptions = {
        url: ufdsUrl,
        bindDN: ufdsDn,
        bindPassword: ufdsPassword
    };

    var UFDS = new sdcClients.UFDS(ufdsOptions);

    UFDS.on('ready', deleteVm);
    UFDS.on('error', function (err) {
        return cb(err);
    });

    function deleteVm() {
        return UFDS.del(dn, function (err) {
            if (err) {
                job.log.info(err, 'Error deleting VM usage from UFDS');
                return cb(null, 'Error deleting VM usage from UFDS. See /info');
            }

            return cb(null, 'Customer VM usage deleted from UFDS');
        });
    }
}



/*
 * Posts back the job parameters to the list of URLs that were passed to the
 * job. Note that this is a task itself, so the job execution state might not
 * be exactly that. We use this task at the end of a job (or as an onError
 * callback) to let anybody know if machine provision was successful and get
 * access to the parameters of the job. We might want to generalize this task
 * as an operation that can be optionally executed as a 'final' task for the job
 * but it's separate from the job tasks themselves
 */
function postBack(job, cb) {
    var urls = job.params['post_back_urls'];
    var vmapiPath = vmapiUrl + '/job_results';

    // By default, post back to VMAPI
    if (urls === undefined || !Array.isArray(urls)) {
        urls = [ vmapiPath ];
    } else {
        urls.push(vmapiPath);
    }

    var obj = clone(job.params);
    obj.execution = job.postBackState || 'succeeded';

    async.mapSeries(urls, function (url, next) {
        var p = urlModule.parse(url);
        var api = restify.createJsonClient({
            url: p.protocol + '//' + p.host,
            headers: { 'x-request-id': job.params['x-request-id'] }
        });
        api.post(p.pathname, obj, onResponse);

        function onResponse(err, req, res) {
            return next(err);
        }

    }, function (err2) {
        if (err2) {
            var errObject = { err: err2, urls: urls };
            job.log.info(errObject, 'Error posting back to URLs');
            cb(null, 'Could not post back job results. See /info object');
        } else {
            cb(null, 'Posted job results back to specified URLs');
        }
    });

    // Shallow clone for the job.params object
    function clone(theObj) {
        if (null === theObj || 'object' != typeof (theObj)) {
            return theObj;
        }

        var copy = theObj.constructor();

        for (var attr in theObj) {
            if (theObj.hasOwnProperty(attr)) {
                copy[attr] = theObj[attr];
            }
        }
        return copy;
    }
}



/*
 * Provisions a list of NICs for the soon to be provisioned machine.
 *
 * The networks list can contain a not null ip attribute on each object, which
 * denotes that we want to allocate that given IP for the correspondant network.
 * This task should be executed after DAPI has allocated a server.
 *
 * If there's at least one NIC with "belongs_to_uuid" set to this machine, then
 * don't provision any new NICs.
 */
function provisionNics(job, cb) {
    var networks = job.params.networks;
    if (networks === undefined) {
        cb('Networks are required');
        return;
    }

    var napi = new sdcClients.NAPI({
        url: napiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });
    var nics = [];

    var primaryFound = false;

    networks.forEach(function (net) {
        if (net.primary)
            primaryFound = true;
        // Make absolutely sure we're never overriding NAPI's network
        // owner checks:
        delete net.check_owner;
    });

    if (!primaryFound && networks.length > 0)
        networks[0].primary = true;

    async.mapSeries(networks, function (network, next) {
        var params = {
            owner_uuid: job.params.owner_uuid,
            belongs_to_uuid: job.params.uuid || job.params.vm_uuid,
            belongs_to_type: 'zone'
        };

        napi.listNics(params, function (err, res) {
            if (err) {
                next(err);
                return;
            }

            res = res.filter(function (nic) {
            return (nic.network_uuid &&
                nic.network_uuid === network.uuid);
            });

            if (res.length > 0) {
                nics = nics.concat(res);
                next();
                return;
            }

            if (network.ip !== undefined)
                params.ip = network.ip;

            if (network.primary !== undefined)
                params.primary = network.primary;

            napi.provisionNic(network.uuid, params, function (suberr, nic) {
                if (suberr) {
                    next(suberr);
                } else {
                    nics.push(nic);
                    next();
                }
            });
        });

    }, function (err2) {
        if (err2) {
            cb(err2);
        } else {
            job.log.info({ nics: job.params.nics }, 'NICs allocated');
            job.params.nics = nics;

            cb(null, 'NICs allocated');
        }
    });
}



/*
 * Provisions additional NICs for a a zone.
 *
 * The networks list can contain a not null ip attribute on each object, which
 * denotes that we want to allocate that given IP for the correspondent network.
 */
function addNics(job, cb) {
    var networks = job.params.networks;
    if (networks === undefined) {
        cb('Networks are required');
        return;
    }

    var napi = new sdcClients.NAPI({
        url: napiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });
    var nics = [];

    async.mapSeries(networks, function (network, next) {
        var params = {
            owner_uuid: job.params.owner_uuid,
            belongs_to_uuid: job.params.uuid || job.params.vm_uuid,
            belongs_to_type: 'zone'
        };

        if (network.ip !== undefined) {
            params.ip = network.ip;
        } else if (network.primary !== undefined) {
            params.primary = network.primary;
        }

        napi.provisionNic(network.uuid, params, function (err, nic) {
            if (err) {
                next(err);
            } else {
                nics.push(nic);
                next();
            }
        });
    }, function (err2) {
        if (err2) {
            cb(err2);
        } else {
            job.log.info({ nics: nics }, 'NICs allocated');
            job.params['add_nics'] = nics;

            cb(null, 'NICs allocated');
        }
    });
}



/*
 * Exactly the same as removeNics but used as a fallback task for provision and
 * add-nics. Those tasks set either a nics or add-nics object to the params.
 * In addition we don't throw an error if the NICs were not added at all
 */
function cleanupNics(job, cb) {
    // Unless it is explicitly false, meaning that cnapi.pollTask succeeded
    if (job.cleanupOnTimeout === false) {
        return cb(null, 'cleanupOnTimeout was set to false');
    }

    var nics = job.params['add_nics'] || job.params['nics'];
    if (nics === undefined) {
        return cb(null, 'No NICs were provisioned');
    }

    var napi = new sdcClients.NAPI({
        url: napiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    async.mapSeries(nics, function (nic, next) {
        napi.deleteNic(nic.mac, function (err) {
            if (err) {
                next(err);
            } else {
                next();
            }
        });
    }, function (err2) {
        if (err2) {
            cb(err2);
        } else {
            cb(null, 'NICs removed');
        }
    });
}



/*
 * Lists the nics that already exist for a VM, and uses that list to
 * update the routes.
 */
function updateNetworkParams(job, cb) {
    var toAdd = job.params.add_nics;
    if (toAdd === undefined) {
        cb('add_nics are required');
        return;
    }

    // From the list of oldResolvers append the new ones
    var i, j, nic, resolver;
    var resolvers = job.params.oldResolvers || [];
    job.log.info(job.params.oldResolvers, 'oldResolvers');

    for (i = 0; i <  toAdd.length; i++) {
        nic = toAdd[i];

        if (nic['resolvers'] !== undefined &&
            Array.isArray(nic['resolvers'])) {
            for (j = 0; j < nic['resolvers'].length; j++) {
                resolver = nic['resolvers'][j];
                if (resolvers.indexOf(resolver) === -1) {
                    resolvers.push(resolver);
                }
            }
        }
    }

    if (job.params.wantResolvers && resolvers.length !== 0) {
        job.params.resolvers = resolvers;
    } else {
        job.params.resolvers = [];
    }

    var napi = new sdcClients.NAPI({
        url: napiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });
    var params = {
        belongs_to_uuid: job.params.uuid || job.params.vm_uuid,
        belongs_to_type: 'zone'
    };

    napi.listNics(params, function (err, res) {
        if (err) {
            cb(err);
            return;
        }

        var routes = {};
        var allNics = res.concat(toAdd);
        for (i = 0; i < allNics.length; i++) {
            nic = allNics[i];

            if (nic['routes'] !== undefined &&
                typeof (nic['routes']) === 'object') {
                for (var r in nic['routes']) {
                    if (!routes.hasOwnProperty(r)) {
                        routes[r] = nic['routes'][r];
                    }
                }
            }
        }

        if (Object.keys(routes).length !== 0) {
            job.params.set_routes = routes;
        }

        return cb(null, 'Added network parameters to payload');
    });
}



/*
 * Updates FWAPI with the current VM's parameters
 */
function updateFwapi(job, cb) {
    var fwapi = restify.createJsonClient({ url: fwapiUrl });
    var jobParams;
    var type;
    var update = {};
    var vmProps = ['add_nics', 'nics', 'remove_ips', 'remove_nics',
        'remove_tags', 'set_tags', 'tags'];

    if (job.params.task === 'provision') {
        jobParams = job.params.payload;
        type = 'vm.add';
    } else {
        jobParams = job.params;
        type = (job.params.task === 'destroy') ? 'vm.delete' : 'vm.update';
    }

    vmProps.forEach(function (prop) {
        if (jobParams.hasOwnProperty(prop)) {
            update[prop] = jobParams[prop];
        }
    });

    job.log.info({ jobParams: jobParams, update: update }, 'update params');

    if (Object.keys(update).length === 0 && job.params.task !== 'destroy') {
        return cb(null, 'No properties affecting FWAPI found: not updating');
    }

    update.owner_uuid = jobParams.owner_uuid;
    update.server_uuid = jobParams.server_uuid;
    update.type = type;
    update.uuid = jobParams.uuid || jobParams.vm_uuid;

    return fwapi.post('/updates', update, function (err, req, res, obj) {
        if (err) {
            return cb(err);
        }

        return cb(null, 'Updated FWAPI with update UUID: ' + obj.update_uuid);
    });
}



/*
 * Lists the nics that already exist for a VM, and uses that list to
 * delete the routes for that network.
 */
function removeNetworkParams(job, cb) {
    var macs = job.params['remove_nics'];
    if (macs === undefined) {
        cb('MAC addresses are required');
        return;
    }

    var oldMacs = job.params.oldMacs;
    if (oldMacs === undefined) {
        cb('Complete list of VM MAC addresses is required');
        return;
    }

    var napi = new sdcClients.NAPI({
        url: napiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    var params = {
        belongs_to_uuid: job.params.uuid || job.params.vm_uuid,
        belongs_to_type: 'zone'
    };

    napi.listNics(params, function (err, res) {
        if (err) {
            cb(err);
            return;
        }

        var i, j, nic;
        var del = [];
        var keepNetworks = [];
        var routes = [];
        var resolversHash = {};

        for (i = 0; i < res.length; i++) {
            nic = res[i];

            if (macs.indexOf(nic.mac) !== -1) {
                del.push(nic);
            } else {
                keepNetworks.push(nic.network_uuid);
                if (nic.resolvers !== undefined &&
                    Array.isArray(nic.resolvers)) {
                    resolversHash[nic.mac] = nic.resolvers;
                }
            }
        }

        job.log.info(res, 'res');
        job.log.info(del, 'del');
        job.log.info(keepNetworks, 'keepNets');
        for (i = 0; i < del.length; i++) {
            nic = del[i];

            // Only delete the routes if there are no other nics on the
            // same network (which therefore have the same routes)
            if (nic['routes'] !== undefined &&
                typeof (nic['routes']) === 'object' &&
                keepNetworks.indexOf(nic.network_uuid) === -1) {
                for (var r in nic['routes']) {
                    if (routes.indexOf(r) === -1) {
                        routes.push(r);
                    }
                }
            }
        }

        if (routes.length !== 0) {
            job.params.remove_routes = routes;
        }

        // We iterate over oldMacs since it has the correct order for the NICs
        // If the MAC is not in the resolversHash then we don't add its resolver
        var mac, resolver;
        var resolvers = [];
        for (i = 0; i < oldMacs.length; i++) {
            mac = oldMacs[i];

            if (resolversHash[mac] !== undefined &&
                Array.isArray(resolversHash[mac])) {
                for (j = 0; j < resolversHash[mac].length; j++) {
                    resolver = resolversHash[mac][j];
                    if (resolvers.indexOf(resolver) === -1) {
                        resolvers.push(resolver);
                    }
                }
            }
        }

        if (job.params.wantResolvers && resolvers.length !== 0) {
            job.params.resolvers = resolvers;
        } else {
            job.params.resolvers = [];
        }

        job.params.remove_ips = del.map(function (n) { return n.ip; });

        return cb(null, 'Added network parameters to payload');
    });
}



/*
 * Calls VMAPI with ?sync=true so we force a cache refresh of the VM. Only being
 * used by the snapshot workflows until the last_modified timestamp change is
 * checked in
 */
function refreshVm(job, cb) {
    if (!job.params['vm_uuid']) {
        cb('No VM UUID provided');
        return;
    }

    if (!vmapiUrl) {
        cb('No VMAPI URL provided');
        return;
    }

    var vmapi = restify.createJsonClient({
        url: vmapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });
    var path = '/vms/' + job.params['vm_uuid'] + '?sync=true';

    vmapi.get(path, onVmapi);

    function onVmapi(err, req, res, vm) {
        if (err) {
            cb(err);
        } else {
            cb(null, 'VM data has been refreshed');
        }
    }
}



module.exports = {
    validateForZoneAction: validateForZoneAction,
    zoneAction: zoneAction,
    pollTask: pollTask,
    checkState: checkState,
    checkUpdated: checkUpdated,
    deleteCustomerVm: deleteCustomerVm,
    postBack: postBack,
    provisionNics: provisionNics,
    addNics: addNics,
    cleanupNics: cleanupNics,
    updateNetworkParams: updateNetworkParams,
    updateFwapi: updateFwapi,
    removeNetworkParams: removeNetworkParams,
    refreshVm: refreshVm
};
