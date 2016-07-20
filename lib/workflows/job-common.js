/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * A brief overview of this source file: what is its purpose.
 */

var restify = require('restify');
var async = require('async');
var papiUrl;


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
 * Clears the "skip_zone_action" flag on the job "job" so that subsequent tasks
 * in a given workflow do not skip any action accidentally.
 */
function clearSkipZoneAction(job, cb) {
    delete job.params.skip_zone_action;

    cb();
}

/*
 * General purpose function to call a CNAPI endpoint. endpoint and requestMethod
 * are required. This function will post the job params object as params for the
 * CNAPI request. Additionally, this function will set a taskId property in the
 * job object so you can optionally poll the status of the task with pollTask
 */
function zoneAction(job, cb) {
    if (job.params['skip_zone_action']) {
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

    // Use payload when available
    var payload = job.params.payload || job.params;

    function callback(err, req, res, task) {
        if (err) {
            cb(err);
        } else {
            job.taskId = task.id;
            cb(null, 'Task id: ' + task.id + ' queued to CNAPI!');
        }
    }

    if (job.requestMethod == 'post') {
        cnapi.post(job.endpoint, payload, callback);
    } else if (job.requestMethod == 'put') {
        cnapi.put(job.endpoint, payload, callback);
    } else if (job.requestMethod == 'del') {
        cnapi.del(job.endpoint, callback);
    } else {
        cb('Unsupported requestMethod: "' + job.requestMethod + '"');
    }
}


function waitTask(job, cb) {
    if (job.params['skip_zone_action']) {
        cb(null, 'Skipping waitTask');
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

    cnapi.waitTask(job.taskId, {}, onTask);

    function onTask(err, task) {
        if (err) {
            if (err.statusCode === 404) {
                // fallback to pollTask
                cnapi.pollTask(job.taskId, {}, function (pollerr, polltask) {
                    // Make sure loops cannot happen
                    if (pollerr && pollerr.statusCode === 404) {
                        cb(pollerr);
                        return;
                    }
                    onTask(pollerr, polltask);
                });
                return;
            }
            cb(err);
        } else if (task && task.status == 'failure') {
            cb(getErrorMesage(task));
        } else if (task && task.status == 'complete') {
            // Tasks that modify VM state should add a .vm to the task
            // with something like "self.finish({ vm: machine });"
            if (task.history && task.history.length > 0 &&
                task.history[0].name === 'finish' &&
                task.history[0].event &&
                task.history[0].event.vm) {

                job.finished_vm = task.history[0].event.vm;
                job.log.debug({vm_uuid: job.finished_vm.uuid},
                    'finish() returned VM');
            }

            cb(null, 'Job succeeded!');
        } else {
            cb(new Error('unexpected task status, ' + task.status));
        }
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
 * Polls the status of a CNAPI task. The two possible final states of a task
 * are failure and completed. taskId is required for this task, so this function
 * is commonly used in conjunction with zoneAction
 */
function pollTask(job, cb) {
    if (job.params['skip_zone_action']) {
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

    // Repeat checkTask until task has finished
    checkTask();

    function checkTask() {
        cnapi.getTask(job.taskId, onCnapi);

        function onCnapi(err, task) {
            if (err) {
                cb(err);
            } else if (task.status == 'failure') {
                cb(new Error(getErrorMesage(task)));
            } else if (task.status == 'complete') {
                // Tasks that modify VM state should add a .vm to the task
                // with something like "self.finish({ vm: machine });"
                if (task.history && task.history.length > 0 &&
                    task.history[0].name === 'finish' &&
                    task.history[0].event &&
                    task.history[0].event.vm) {

                    job.finished_vm = task.history[0].event.vm;
                    job.log.debug({vm_uuid: job.finished_vm.uuid},
                        'finish() returned VM');
                }

                cb(null, 'Job succeeded!');
            } else {
                if (job.timeToDie) {
                    job.log.error('pollTask.checkTask.onCnapi called after task'
                        + 'completion, breaking loop');
                    return;
                }
                setTimeout(checkTask, 1000);
            }
        }
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

function putVm(job, cb) {
    var vmapi;

    /*
     * Checks (polls) the state of a machine in VMAPI. It is used for provisions
     * and VM actions such as reboot and shutdown.
     *
     * IMPORTANT: this function an all uses of job.expects are deprecated and
     *            will be removed in a future version after everyone is updated
     *            past the old agent tasks that don't pass back the VMs. It is
     *            being replaced with the putVm function and is now only called
     *            from there.
     */
    function checkState(_job, _cb) {
        if (_job.params['skip_zone_action']) {
            _cb(null, 'Skipping checkState');
            return;
        }

        // For now don't fail the job if this parameter is not present
        if (!_job.expects) {
            _cb(null, 'No \'expects\' state parameter provided');
            return;
        }

        if (!_job.params['vm_uuid']) {
            _cb('No VM UUID provided');
            return;
        }

        if (!vmapiUrl) {
            _cb('No VMAPI URL provided');
            return;
        }

        var _vmapi = new sdcClients.VMAPI({
            url: vmapiUrl,
            headers: { 'x-request-id': _job.params['x-request-id'] }
        });

        // Repeat checkVm until VM data is updated
        checkVm();

        function checkVm() {
            _vmapi.getVm({ uuid: _job.params['vm_uuid'] }, onVmapi);

            function onVmapi(err, vm, req, res) {
                if (err) {
                    _cb(err);
                } else if (vm.state == _job.expects) {
                    _cb(null, 'VM is now ' + _job.expects);
                } else {
                    if (_job.timeToDie) {
                        _job.log.error('checkState.checkVm.onVmapi called after'
                            + ' task completion, breaking loop');
                        return;
                    }
                    setTimeout(checkVm, 1000);
                }
            }
        }
    }

    if (!job.finished_vm) {
        job.log.warn({req_id: job.params['x-request-id']},
            'putVM() called but job.finished_vm is missing');

        checkState(job, cb);
        //
        // When checkState is removed:
        //
        // cb(null, 'job has no finished_vm, nothing to post to VMAPI');
        return;
    }

    if (!vmapiUrl) {
        cb(new Error('No VMAPI URL provided'));
        return;
    }

    job.log.debug({vmobj: job.finished_vm}, 'putVM() putting VM to VMAPI');

    //
    // Borrowed from vm-agent lib/vmapi-client.js
    //
    // DO NOT TRY THIS AT HOME!
    //
    // afaict the reason sdcClients does not have a putVm function in the first
    // place is that this is not something API clients should generally be
    // doing. WE need to do it, and vm-agent needs to do it, but other clients
    // should not be doing it unless they're absolutely sure that what they're
    // PUTing is the current state.
    //
    // We know that here because cn-agent tasks just did a VM.load for us.
    //
    sdcClients.VMAPI.prototype.putVm = function (vm, callback) {
        var log = job.log;
        var opts = { path: '/vms/' + vm.uuid };

        this.client.put(opts, vm, function (err, req, res) {
            if (err) {
                log.error(err, 'Could not update VM %s', vm.uuid);
                return callback(err);
            }

            log.info('VM (uuid=%s, state=%s, last_modified=%s) updated @ VMAPI',
                vm.uuid, vm.state, vm.last_modified);
            return callback();
        });
    };

    vmapi = new sdcClients.VMAPI({
        log: job.log,
        url: vmapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    vmapi.putVm(job.finished_vm, function (err) {
        if (err) {
            cb(err);
            return;
        }

        cb(null, 'put VM ' + job.finished_vm.uuid + ' to VMAPI');
    });
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

    // Repeat checkVm until VM data is updated
    checkVm();

    function checkVm() {
        vmapi.listVms({ uuid: job.params['vm_uuid'] }, onVmapi);

        function onVmapi(err, vms, req, res) {
            if (err) {
                cb(err);
            } else if (vms.length && (vms[0].uuid == job.params['vm_uuid'])) {
                var newDate = new Date(vms[0]['last_modified']);

                if (newDate > oldDate) {
                    cb(null, 'VM data has been updated');
                } else {
                    if (job.timeToDie) {
                        job.log.error('checkUpdated.checkVm.onVmapi called '
                            + 'after task completion, breaking loop');
                        return;
                    }
                    setTimeout(checkVm, 1000);
                }
            }
        }
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
    if (job.markAsFailedOnError === false) {
        return cb(null, 'markAsFailedOnError was set to false, ' +
            'won\'t postBack provision failure to VMAPI');
    }

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
 * Gets a list of NIC tags after validating every network provided
 */
function validateNetworks(job, cb) {
    var networks = job.params.networks;

    // add-nics also calls this function, but if macs are provided we don't
    // necessarily need to progress further
    if (job.params.macs && !networks) {
        return cb();
    }

    var newNetworks = [];
    if (!networks) {
        return cb('Networks are required');
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
            // If network is not found then it might be a network pool
            if (err && err.name !== 'ResourceNotFoundError') {
                return callback(err);
            }

            // Did we get the network from list or get?
            var net = (Array.isArray(nets) ? nets[0] : nets);
            // No net if NAPI returns an empty array or if we got a 404
            if (net) {
                job.nicTags.push(net.nic_tag);
                return callback(null, net.uuid);
            }

            // We might be trying to provision on a network pool, so
            // try that instead
            poolFn.call(napi, params, function (err2, pools) {
                if (err2) {
                    return callback(err2);
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
        if (network.ipv4_uuid !== undefined) {
            netId = network.ipv4_uuid;
        } else if (network.name !== undefined) {
            netId = network.name;
        }

        getNetwork(netId, function (err, uuid) {
            if (err) {
                next(err);
            } else {
                network.uuid = uuid;
                network.ipv4_uuid = uuid;
                newNetworks.push(network);
                next();
            }
        });

    }, function (err2) {
        if (err2) {
            cb(err2);
        } else {
            job.params.networks = newNetworks;
            job.log.info({ nicTags: job.nicTags }, 'NIC Tags retrieved');
            cb(null, 'Networks are valid');
        }
    });
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

    // Every NIC we provision is added to this array
    var nics = [];
    var primaryFound = false;
    job.params.fabricNatNics = [];

    networks.forEach(function (net) {
        if (net.primary)
            primaryFound = true;
        // Make absolutely sure we're never overriding NAPI's network
        // owner checks:
        delete net.check_owner;
    });

    if (!primaryFound && networks.length > 0)
        networks[0].primary = true;

    // Return a new copy for every time we provision a new NIC and avoid
    // accidentally reusing an object
    function nicParams() {
        return {
            owner_uuid: job.params.owner_uuid,
            belongs_to_uuid: job.params.uuid || job.params.vm_uuid,
            belongs_to_type: 'zone'
        };
    }

    // If this is a nic on a fabric, has no gateway provisioned, and the network
    // requests an internet NAT, add it
    function addFabricNatNic(fNic) {
        if (fNic && fNic.fabric && fNic.gateway && !fNic.gateway_provisioned &&
                fNic.ip !== fNic.gateway && fNic.internet_nat) {
            job.params.fabricNatNics.push(fNic);
        }
    }

    // Get current list of NICs that might have been provisioned ahead of time
    napi.listNics(nicParams(), function (err, res) {
        if (err) {
            cb(err);
            return;
        }
        return asyncProvisionNics(res);
    });

    function asyncProvisionNics(currentNics) {
        async.mapSeries(networks, function (network, next) {
            // If there is at least one provisioned NIC in one of the networks
            // provided, skip napi.provisionNic for this network
            var netNics = currentNics.filter(function (nic) {
                return (nic.network_uuid && nic.network_uuid ===
                    network.ipv4_uuid);
            });

            if (netNics.length > 0) {
                nics = nics.concat(netNics);
                next();
                return;
            }

            var antiSpoofParams = ['allow_dhcp_spoofing', 'allow_ip_spoofing',
                'allow_mac_spoofing', 'allow_restricted_traffic'];
            var params = nicParams();
            params.cn_uuid = job.params.server_uuid;
            if (network.ipv4_ips !== undefined)
                params.ip = network.ipv4_ips[0];
            if (network.primary !== undefined)
                params.primary = network.primary;

            antiSpoofParams.forEach(function (spoofParam) {
                if (network.hasOwnProperty(spoofParam)) {
                    params[spoofParam] = network[spoofParam];
                }
            });

            napi.provisionNic(network.ipv4_uuid, params,
                function (suberr, nic) {
                if (suberr) {
                    next(suberr);
                } else {
                    nics.push(nic);
                    addFabricNatNic(nic);
                    next();
                }
            });
        }, function (err2) {
            if (err2) {
                cb(err2);
            } else {
                job.params.nics = nics;
                job.log.info({ nics: job.params.nics }, 'NICs allocated');

                cb(null, 'NICs allocated');
            }
        });
    }
}



/*
 * Provisions additional NICs for a zone in NAPI if networks were provided to
 * the job. If macs were provided, load those from NAPI instead.
 *
 * The networks list can contain a not null ip attribute on each object, which
 * denotes that we want to allocate that given IP for the correspondent network.
 */
function addNics(job, cb) {
    var networks = job.params.networks;
    var macs     = job.params.macs;

    if (networks === undefined && macs === undefined) {
        cb('Networks or mac are required');
        return;
    }

    var napi = new sdcClients.NAPI({
        url: napiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    var nics = [];

    function done(err) {
        if (err) {
            cb(err);
        } else {
            job.log.info({ nics: nics }, 'NICs allocated');
            job.params['add_nics'] = nics;

            cb(null, 'NICs looked up or allocated');
        }
    }

    if (macs) {
        async.mapSeries(macs, function (mac, next) {
            napi.getNic(mac, function (err, nic) {
                if (err) {
                    return next(err);
                }

                nics.push(nic);
                next();
            });
        }, done);
    } else {
        async.mapSeries(networks, function (network, next) {
            var params = {
                owner_uuid: job.params.owner_uuid,
                belongs_to_uuid: job.params.uuid || job.params.vm_uuid,
                belongs_to_type: 'zone',
                state: 'provisioning'
            };

            var antiSpoofParams = ['allow_dhcp_spoofing', 'allow_ip_spoofing',
                'allow_mac_spoofing', 'allow_restricted_traffic'];
            if (network.ip !== undefined) {
                params.ip = network.ip;
            } else if (network.primary !== undefined) {
                params.primary = network.primary;
            }

            antiSpoofParams.forEach(function (spoofParam) {
                if (network.hasOwnProperty(spoofParam)) {
                    params[spoofParam] = network[spoofParam];
                }
            });

            napi.provisionNic(network.uuid, params, function (err, nic) {
                if (err) {
                    next(err);
                } else {
                    nics.push(nic);
                    next();
                }
            });
        }, done);
    }
}



/*
 * Exactly the same as removeNics but used as a fallback task for provision and
 * add-nics. Those tasks set either a nics or add-nics object to the params.
 * We also need to handle the case where NIC objects were already created in
 * napi beforehand, and the MAC addresses of those NICs were provided.
 *
 * In addition, we don't throw an error if the NICs were not added at all.
 */
function cleanupNics(job, cb) {
    // If this is false it means that cnapi.pollTask succeeded, so the VM exists
    // physically wether its provision failed or not
    if (job.markAsFailedOnError === false) {
        return cb(null, 'markAsFailedOnError was set to false, ' +
            'won\'t cleanup VM NICs');
    }

    var macs = job.params.macs;

    if (!macs) {
            var nics = job.params['add_nics'] || job.params['nics'];

            if (!nics) {
                return cb(null, 'No MACs given, and no NICs were provisioned');
            }

            macs = nics.map(function (nic) { return nic.mac; });
    }

    var napi = new sdcClients.NAPI({
        url: napiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    async.mapSeries(macs, function (mac, next) {
        napi.deleteNic(mac, next);
    }, function (err) {
        if (err) {
            cb(err);
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
    var fwapi = new sdcClients.FWAPI({
        url: fwapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });
    var jobParams = job.params.payload || job.params;
    var type;
    var update = {};
    var vmProps = ['add_nics', 'firewall_enabled', 'nics', 'remove_ips',
        'remove_nics', 'remove_tags', 'set_tags', 'tags'];

    if (job.params.task === 'provision') {
        type = 'vm.add';
    } else {
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
    update.uuid = jobParams.uuid || jobParams.vm_uuid || job.params.vm_uuid;

    return fwapi.createUpdate(update, function (err, obj) {
        if (err) {
            job.log.warn(err, 'Error sending update to FWAPI');
            return cb(null, 'Error updating FWAPI');
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
 * used by the failure handling in provision workflow, and in the snapshot
 * workflow until the last_modified timestamp change is checked in.
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

    /*
     * When job.markAsFailedOnError is set, we won't automatically update the
     * VM in VMAPI to state 'failed'. This is because there may be NICs in use.
     * However, for the case where we have failed to create something correctly,
     * we want to ensure VMAPI gets to the correct state. So we do a GET with
     * sync=true here at the end of the onerror chain to ensure VMAPI's
     * up-to-date. But only when the 'failed' state was not set already.
     */
    if (job.markAsFailedOnError !== false) {
        return cb(null, 'markAsFailedOnError set, not doing sync GET');
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
            cb(null, 'VM data refreshed, new VM state is ' + vm.state);
        }
    }
}


/*
 * Used by start/stop/reboot actions to ensure the VM is in a required state
 * before calling the correspondent action
 */
function ensureVmState(job, cb) {
    var vmapi = new sdcClients.VMAPI({ url: vmapiUrl });
    var desiredStates = {
        'start': 'stopped',
        'stop': 'running',
        'reboot': 'running'
    };

    vmapi.getVm({ uuid: job.params['vm_uuid'] }, function (err, vm, req, res) {
        if (err) {
            cb(err);
        } else if (job.params.idempotent) {
            cb(null, 'VM is ' + vm.state + ', action is idempotent');
        } else if (vm.state !== desiredStates[job.params.task]) {
            cb(new Error('Cannot ' + job.params.task + ' a VM from a \'' +
                vm.state + '\' state'));
        } else {
            cb(null, 'VM is ' + vm.state);
        }
        return;
    });
}



function acquireVMTicket(job, cb) {
    var cnapi = new sdcClients.CNAPI({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });
    var server_uuid = job.params.server_uuid;
    var newTicket = {
        scope: 'vm',
        id: job.params.vm_uuid,
        expires_at: (new Date(
            Date.now() + 600 * 1000).toISOString()),
        action: job.action
    };

    if (job.action === 'provision') {
        newTicket.extra = {
            workflow_job_uuid: job.uuid,
            owner_uuid: job.params.owner_uuid,
            max_physical_memory: job.params.max_physical_memory,
            cpu_cap: job.params.cpu_cap,
            quota: job.params.quota,
            brand: job.params.brand,
            disks: job.params.disks
        };

        if (job.params.brand === 'kvm' && job.params.image) {
            newTicket.extra.image_size = job.params.image.image_size;
        }
    }

    cnapi.waitlistTicketCreate(server_uuid, newTicket, onCreate);

    function onCreate(err, ticket) {
        if (err) {
            cb(err);
            return;
        }

        // look up ticket, ensure it's not expired etc
        cnapi.waitlistTicketGet(ticket.uuid,
            function (geterr, getticket) {
                if (geterr) {
                    cb(geterr);
                    return;
                }
                job.ticket = getticket;
                job.log.info(
                    { ticket: getticket }, 'ticket status after wait');
                cb();
            });
    }
}


function waitOnVMTicket(job, cb) {
    var cnapi = new sdcClients.CNAPI({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    var ticket = job.ticket;

    if (ticket.status === 'active') {
        cb();
        return;
    }
    cnapi.waitlistTicketWait(job.ticket.uuid, cb);
}


function releaseVMTicket(job, cb) {
    if (!job.ticket) {
        return cb();
    }
    var cnapi = new sdcClients.CNAPI({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });
    cnapi.waitlistTicketRelease(job.ticket.uuid, function (err) {
        if (err) {
            job.log.warn({err: err, ticket: job.ticket},
                'error releasing CNAPI waitlist VM ticket');
        }
        cb(err);
    });
}


function acquireAllocationTicket(job, cb) {
    var cnapi = new sdcClients.CNAPI({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    // Find the headnode
    cnapi.listServers({ headnode: true }, function (err, headnodes) {
        if (err) {
            cb(err);
            return;
        }

        if (!headnodes || !headnodes.length) {
            cb(new Error('no headnodes returned'));
            return;
        }

        var newTicket = {
            scope: 'vm-allocate',
            id: 'global',
            expires_at: (new Date(
                Date.now() + 60 * 1000).toISOString()),
            action: 'allocate',
            workflow_job_uuid: job.uuid
        };

        cnapi.waitlistTicketCreate(headnodes[0].uuid, newTicket, onCreate);
    });


    function onCreate(err, ticket) {
        if (err) {
            cb(err);
            return;
        }

        cnapi.waitlistTicketGet(
            ticket.uuid, function (geterr, getticket)
        {
            if (geterr) {
                cb(geterr);
                return;
            }
            job.allocationTicket = getticket;
            cb();
        });
    }
}


function waitOnAllocationTicket(job, cb) {
    var cnapi = new sdcClients.CNAPI({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });

    var allocationTicket = job.allocationTicket;

    if (allocationTicket.status === 'active') {
        return cb();
    }

    cnapi.waitlistTicketWait(allocationTicket.uuid, cb);
}


function releaseAllocationTicket(job, cb) {
    if (!job.allocationTicket) {
        return cb();
    }
    var cnapi = new sdcClients.CNAPI({
        url: cnapiUrl,
        headers: { 'x-request-id': job.params['x-request-id'] }
    });
    cnapi.waitlistTicketRelease(job.allocationTicket.uuid, function (err) {
        if (err) {
            job.log.warn({err: err, ticket: job.ticket},
                'error releasing CNAPI waitlist allocation ticket');
            return;
        }
        cb();
    });
}


module.exports = {
    validateForZoneAction: validateForZoneAction,
    zoneAction: zoneAction,
    waitTask: waitTask,
    pollTask: pollTask,
    putVm: putVm,
    checkUpdated: checkUpdated,
    postBack: postBack,
    provisionNics: provisionNics,
    addNics: addNics,
    cleanupNics: cleanupNics,
    validateNetworks: validateNetworks,
    updateNetworkParams: updateNetworkParams,
    updateFwapi: updateFwapi,
    removeNetworkParams: removeNetworkParams,
    refreshVm: refreshVm,
    ensureVmState: ensureVmState,
    acquireVMTicket: acquireVMTicket,
    waitOnVMTicket: waitOnVMTicket,
    releaseVMTicket: releaseVMTicket,
    acquireAllocationTicket: acquireAllocationTicket,
    waitOnAllocationTicket: waitOnAllocationTicket,
    releaseAllocationTicket: releaseAllocationTicket,
    clearSkipZoneAction: clearSkipZoneAction
};
