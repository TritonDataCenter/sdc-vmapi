/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

// var test = require('tap').test;
var assert = require('assert');
var uuid = require('libuuid');
var qs = require('querystring');
var async = require('async');

var common = require('./common');


// --- Globals

var client;
var muuid;
var newUuid;
var jobLocation;
var vmLocation;
var pkgId;

var IMAGE = 'fd2cc906-8938-11e3-beab-4359c665ac99';
var CUSTOMER = common.config.ufdsAdminUuid;
var NETWORKS = null;
var SERVER = null;
var CALLER = {
    type: 'signature',
    ip: '127.0.0.68',
    keyId: '/foo@joyent.com/keys/id_rsa'
};

// In seconds
var TIMEOUT = 120;


// --- Helpers

function checkMachine(t, vm) {
    t.ok(vm.uuid, 'uuid');
    t.ok(vm.brand, 'brand');
    t.ok(vm.ram, 'ram');
    t.ok(vm.max_swap, 'swap');
    t.ok(vm.quota, 'disk');
    t.ok(vm.cpu_shares, 'cpu shares');
    t.ok(vm.max_lwps, 'lwps');
    t.ok(vm.create_timestamp, 'create timestamp');
    t.ok(vm.state, 'state');
    t.ok(vm.zfs_io_priority, 'zfs io');
    t.ok(vm.owner_uuid, 'owner uuid');
}


function checkJob(t, job) {
    t.ok(job.uuid, 'uuid');
    t.ok(job.name, 'name');
    t.ok(job.execution, 'execution');
    t.ok(job.params, 'params');
}


function checkEqual(value, expected) {
    if ((typeof (value) === 'object') && (typeof (expected) === 'object')) {
        var exkeys = Object.keys(expected);
        for (var i = 0; i < exkeys.length; i++) {
            var key = exkeys[i];
            if (value[key] !== expected[key])
                return false;
        }

        return true;
    } else {
        return (value === expected);
    }
}


function checkValue(url, key, value, callback) {
    return client.get(url, function (err, req, res, body) {
        if (err) {
            return callback(err);
        }

        return callback(null, checkEqual(body[key], value));
    });
}


var times = 0;

function waitForValue(url, key, value, callback) {

    function onReady(err, ready) {
        if (err) {
            callback(err);
            return;
        }

        if (!ready) {
            times++;

            if (times == TIMEOUT) {
                throw new Error('Timeout waiting on ' + url);
            } else {
                setTimeout(function () {
                    waitForValue(url, key, value, callback);
                }, 1000);
            }
        } else {
            times = 0;
            callback(null);
        }
    }

    return checkValue(url, key, value, onReady);
}


function waitForNicState(t, query, state, waitCallback) {
    var stop = false;
    var count = 0;
    var maxSeconds = 30;

    function getNicStatus(callback) {
        client.napi.get({
            path: '/nics',
            query: query
        }, function (err, req, res, nics) {
            if (err) {
                return callback(err);
            } else if (!nics.length || !nics[0].state) {
                // Log the state of the nics so that we know why we failed
                t.deepEqual(nics, {}, 'nics - query: ' + JSON.stringify(query));
                return callback(new Error('VM does not have valid NICs'));
            } else {
                return callback(null, nics[0].state);
            }
        });
    }

    async.doWhilst(
        function (callback) {
            getNicStatus(function (err, nicState) {
                if (err) {
                    return callback(err);
                }

                count++;
                // Assume just one NIC
                if (nicState === state) {
                    stop = true;
                    return callback();
                } else if (count === maxSeconds) {
                    stop = true;
                    return callback(new Error('Timeout waiting on NIC state ' +
                        'change from ' + nicState + ' to ' + state));
                }

                setTimeout(callback, 1000);
            });
        },
        function () { return !stop; },
        waitCallback);
}


function createOpts(path, params) {
    return {
        path: path,
        headers: {
            'x-request-id': uuid.create(),
            'x-context': JSON.stringify({
                caller: CALLER,
                params: params || {}
            })
        }
    };
}



// --- Tests

exports.setUp = function (callback) {
    common.setUp(function (err, _client) {
        assert.ifError(err);
        assert.ok(_client, 'restify client');
        client = _client;
        callback();
    });
};


exports.find_headnode = function (t) {
    client.cnapi.get('/servers', function (err, req, res, servers) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.ok(servers);
        t.ok(Array.isArray(servers));
        for (var i = 0; i < servers.length; i++) {
            if (servers[i].headnode === true) {
                SERVER = servers[i];
                break;
            }
        }
        t.ok(SERVER);
        t.done();
    });
};


exports.napi_networks_ok = function (t) {
    client.napi.get('/networks', function (err, req, res, networks) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        t.ok(networks);
        t.ok(Array.isArray(networks));
        t.ok(networks.length > 1);
        NETWORKS = networks;
        t.done();
    });
};


exports.filter_vms_empty = function (t) {
    var path = '/vms?ram=32&owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        t.ok(Array.isArray(body));
        t.ok(!body.length);
        t.done();
    });
};


exports.filter_vms_ok = function (t) {
    var path = '/vms?ram=' + 128 + '&owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['x-joyent-resource-count']);
        t.ok(body);
        t.ok(Array.isArray(body));
        t.ok(body.length);
        body.forEach(function (m) {
            checkMachine(t, m);
            muuid = m.uuid;
            // Any non-null package works
            if (m['billing_id'] &&
                m['billing_id'] !== '00000000-0000-0000-0000-000000000000') {
                pkgId = m['billing_id'];
            }
        });
        t.done();
    });
};


exports.filter_vms_advanced = function (t) {
    var query = qs.escape('(&(ram>=128)(tags=*-smartdc_type=core-*))');
    var path = '/vms?query=' + query;

    client.get(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['x-joyent-resource-count']);
        t.ok(body);
        t.ok(Array.isArray(body));
        t.ok(body.length);
        t.done();
    });
};


exports.limit_vms_ok = function (t) {
    var path = '/vms?limit=5';

    client.get(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['x-joyent-resource-count']);
        t.ok(body);
        t.ok(Array.isArray(body));
        t.equal(body.length, 5);
        t.done();
    });
};


exports.head_vms_ok = function (t) {
    var path = '/vms?ram=' + 128 + '&owner_uuid=' + CUSTOMER;
    client.head(path, function (err, req, res) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['x-joyent-resource-count']);
        t.done();
    });
};


exports.get_vm_not_found = function (t) {
    var nouuid = uuid.create();
    var path = '/vms/' + nouuid + '?owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, body) {
        t.equal(res.statusCode, 404);
        common.checkHeaders(t, res.headers);
        t.done();
    });
};


exports.get_vm_ok = function (t) {
    var path = '/vms/' + muuid + '?owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'vm ok');
        checkMachine(t, body);
        t.done();
    });
};


exports.head_vm_ok = function (t) {
    var path = '/vms/' + muuid + '?owner_uuid=' + CUSTOMER;
    client.head(path, function (err, req, res) {
        t.ifError(err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.done();
    });
};


exports.create_vm_not_ok = function (t) {
    client.post('/vms', { owner_uuid: CUSTOMER },
      function (err, req, res, data) {
        t.equal(res.statusCode, 409);
        common.checkHeaders(t, res.headers);
        t.done();
    });
};


exports.create_vm_locality_not_ok = function (t) {
    var vm = {
        owner_uuid: CUSTOMER,
        image_uuid: IMAGE,
        server_uuid: SERVER.uuid,
        networks: [ { uuid: NETWORKS[0].uuid } ],
        brand: 'joyent-minimal',
        billing_id: '00000000-0000-0000-0000-000000000000',
        ram: 64,
        quota: 10,
        creator_uuid: CUSTOMER,
        locality: { 'near': 'asdasd' }
    };

    var opts = createOpts('/vms', vm);

    client.post(opts, vm, function (err, req, res, body) {
        t.equal(res.statusCode, 409);
        t.deepEqual(body, {
            code: 'ValidationFailed',
            message: 'Invalid VM parameters',
            errors: [ {
                field: 'locality',
                code: 'Invalid',
                message: 'locality contains malformed UUID'
            } ]
        });
        t.done();
    });
};


exports.create_vm = function (t) {
    var md = {
        foo: 'bar',
        credentials: JSON.stringify({ 'user_pw': '12345678' })
    };

    var vm = {
        owner_uuid: CUSTOMER,
        image_uuid: IMAGE,
        server_uuid: SERVER.uuid,
        networks: [ { uuid: NETWORKS[0].uuid } ],
        brand: 'joyent-minimal',
        billing_id: '00000000-0000-0000-0000-000000000000',
        ram: 64,
        quota: 10,
        customer_metadata: md,
        creator_uuid: CUSTOMER,
        origin: 'cloudapi',
        role_tags: ['fd48177c-d7c3-11e3-9330-28cfe91a33c9']
    };

    var opts = createOpts('/vms', vm);

    client.post(opts, vm, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['workflow-api'], 'workflow-api header');
        t.ok(body, 'vm ok');

        jobLocation = '/jobs/' + body.job_uuid;
        newUuid = body.vm_uuid;
        vmLocation = '/vms/' + newUuid;

        // GetVm should not fail after provision has been queued
        client.get(vmLocation, function (err2, req2, res2, body2) {
            t.ifError(err2);
            t.equal(res2.statusCode, 200, '200 OK');
            common.checkHeaders(t, res2.headers);
            t.ok(body2, 'provisioning vm ok');

            client.post(vmLocation, { action: 'stop' },
              function (err3, req3, res3, body3) {
                t.equal(res3.statusCode, 409, 'cannot stop unprovisioned VM');
                common.checkHeaders(t, res3.headers);
                t.done();
            });
        });
    });
};


exports.get_job = function (t) {
    client.get(jobLocation, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200, 'GetJob 200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'job ok');
        checkJob(t, body);
        t.done();
    });
};


exports.wait_provisioned_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};



exports.check_create_vm_nics_running = function (t) {
    var query = {
        belongs_to_uuid: newUuid,
        belongs_to_type: 'zone'
    };

    waitForNicState(t, query, 'running', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.stop_vm = function (t) {
    var params = {
        action: 'stop'
    };

    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['workflow-api'], 'workflow-api header');
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_stopped_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.check_stop_vm_nics_stopped = function (t) {
    var query = {
        belongs_to_uuid: newUuid,
        belongs_to_type: 'zone'
    };

    waitForNicState(t, query, 'stopped', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.start_vm = function (t) {
    var params = {
        action: 'start'
    };

    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['workflow-api'], 'workflow-api header');
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_started_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.check_start_vm_nics_running = function (t) {
    var query = {
        belongs_to_uuid: newUuid,
        belongs_to_type: 'zone'
    };

    waitForNicState(t, query, 'running', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.reboot_vm = function (t) {
    var params = {
        action: 'reboot'
    };

    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_rebooted_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.check_reboot_vm_nics_running = function (t) {
    var query = {
        belongs_to_uuid: newUuid,
        belongs_to_type: 'zone'
    };

    waitForNicState(t, query, 'running', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.add_nics_with_networks = function (t) {
    var params = {
        action: 'add_nics',
        networks: [ { uuid: NETWORKS[1].uuid } ]
    };

    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        t.ok(body.job_uuid, 'job_uuid: ' + body.job_uuid);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_add_nics_with_networks = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.check_add_nics_with_network_nics_running = function (t) {
    var query = {
        belongs_to_uuid: newUuid,
        belongs_to_type: 'zone',
        nic_tag: NETWORKS[1].nic_tag
    };

    waitForNicState(t, query, 'running', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.add_nics_with_macs = function (t) {
    var params = {
        belongs_to_uuid: newUuid,
        belongs_to_type: 'zone',
        owner_uuid: CUSTOMER,
        network_uuid: NETWORKS[1].uuid,
        nic_tag: NETWORKS[1].nic_tag,
        status: 'provisioning'
    };

    var opts = createOpts('/nics', params);

    client.napi.post(opts, params, function (err, req, res, nic) {
        t.ifError(err);

        var params2 = {
            action: 'add_nics',
            macs: [ nic.mac ]
        };

        var opts2 = createOpts(vmLocation, params2);

        client.post(opts2, params2, function (err2, req2, res2, body2) {
            t.ifError(err2);
            t.equal(res2.statusCode, 202);
            common.checkHeaders(t, res2.headers);
            t.ok(body2);
            jobLocation = '/jobs/' + body2.job_uuid;
            t.done();
        });
    });
};


exports.wait_add_nics_with_macs = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.check_add_nics_with_macs_nics_running = function (t) {
    var query = {
        belongs_to_uuid: newUuid,
        belongs_to_type: 'zone',
        nic_tag: NETWORKS[1].nic_tag
    };

    waitForNicState(t, query, 'running', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.remove_nics = function (t) {
    // Get VM object to get its NICs
    client.get(vmLocation, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'vm ok');
        checkMachine(t, body);
        t.ok(body.nics);
        t.equal(body.nics.length, 3);

        var macs = body.nics.filter(function (nic) {
            return nic.nic_tag === NETWORKS[1].nic_tag;
        }).map(function (nic) {
            return nic.mac;
        });

        t.equal(macs.length, 2);

        var params = {
            action: 'remove_nics',
            macs: macs
        };

        var opts = createOpts(vmLocation, params);

        client.post(opts, params, function (err2, req2, res2, body2) {
            t.ifError(err2);
            t.equal(res2.statusCode, 202);
            common.checkHeaders(t, res2.headers);
            t.ok(body2);
            jobLocation = '/jobs/' + body2.job_uuid;
            t.done();
        });
    });
};


exports.wait_remove_nics = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.check_remove_nics_removed = function (t) {
    client.napi.get({
        path: '/nics',
        query: {
            belongs_to_uuid: newUuid,
            belongs_to_type: 'zone',
            nic_tag: NETWORKS[1].nic_tag
        }
    }, function (err, req, res, nics) {
        t.ifError(err);
        t.equal(nics.length, 0);
        t.done();
    });
};


// Adding this test due to JPC-1045 bug, where a change to owner_uuid was
// requested with an empty owner_uuid value:
exports.change_owner_without_uuid = function (t) {
    var params = {
        action: 'update',
        owner_uuid: ''
    };

    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
          t.equal(res.statusCode, 409);
          t.done();
    });
};



exports.list_tags = function (t) {
    var path = '/vms/' + newUuid + '/tags?owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'body');
        t.ok(!Object.keys(body).length, 'empty body');
        t.done();
    });
};


exports.add_tags = function (t) {
    var path = '/vms/' + newUuid + '/tags?owner_uuid=' + CUSTOMER;

    var query = {
        role: 'database',
        group: 'deployment'
    };

    var opts = createOpts(path, query);

    client.post(opts, query, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_new_tag_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.wait_new_tag = function (t) {
    var tags = {
        role: 'database',
        group: 'deployment'
    };

    waitForValue(vmLocation, 'tags', tags, function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.get_tag = function (t) {
    var path = '/vms/' + newUuid + '/tags/role?owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, data) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        common.checkHeaders(t, res.headers);
        t.ok(data);
        t.equal(data, 'database');
        t.done();
    });
};


exports.delete_tag = function (t) {
    var path = '/vms/' + newUuid + '/tags/role?owner_uuid=' + CUSTOMER;

    var opts = createOpts(path, { owner_uuid: CUSTOMER });

    client.del(opts, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_delete_tag_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.wait_delete_tag = function (t) {
    var tags = {
        group: 'deployment'
    };

    waitForValue(vmLocation, 'tags', tags, function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.delete_tags = function (t) {
    var path = '/vms/' + newUuid + '/tags?owner_uuid=' + CUSTOMER;

    var opts = createOpts(path, { owner_uuid: CUSTOMER });

    client.del(opts, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_delete_tags_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.wait_delete_tags = function (t) {
    waitForValue(vmLocation, 'tags', {}, function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.set_tags = function (t) {
    var path = '/vms/' + newUuid + '/tags?owner_uuid=' + CUSTOMER;

    var query = {
        role: 'database',
        group: 'deployment'
    };

    var opts = createOpts(path, query);

    client.put(opts, query, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_set_tags_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.wait_set_tags = function (t) {
    var tags = {
        role: 'database',
        group: 'deployment'
    };

    waitForValue(vmLocation, 'tags', tags, function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.snapshot_vm = function (t) {
    var params = {
        action: 'create_snapshot',
        snapshot_name: 'backup'
    };

    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_snapshot_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.rollback_vm = function (t) {
    var params = {
        action: 'rollback_snapshot',
        snapshot_name: 'backup'
    };

    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_rollback_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.delete_snapshot = function (t) {
    var params = {
        action: 'delete_snapshot',
        snapshot_name: 'backup'
    };

    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_delete_snapshot_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.reprovision_vm = function (t) {
    var repdata = {
        action: 'reprovision',
        image_uuid: IMAGE
    };

    var opts = createOpts(vmLocation, repdata);

    client.post(opts, repdata, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_reprovision_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.destroy_vm = function (t) {
    var opts = createOpts(vmLocation);

    client.del(opts, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_destroyed_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.filter_jobs_ok = function (t) {
    var path = '/jobs?task=provision&vm_uuid=' + newUuid;

    client.get(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        t.ok(Array.isArray(body));
        t.equal(body.length, 1);
        t.done();
    });
};


exports.filter_vm_jobs_ok = function (t) {
    var path = '/vms/' + newUuid + '/jobs?task=reboot';

    client.get(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        t.ok(Array.isArray(body));
        t.equal(body.length, 1);
        t.done();
    });
};


exports.get_audit = function (t) {
    client.get('/jobs?vm_uuid=' + newUuid, function (err, req, res, jobs) {
        t.ifError(err);

        var expectedNames = [
            'destroy', 'reprovision', 'delete-snapshot', 'rollback', 'snapshot',
            'update', 'update', 'update', 'update', 'remove-nic', 'add-nics',
            'add-nics', 'reboot', 'start', 'stop', 'provision'
        ];

        for (var i = 0; i !== expectedNames.length; i++) {
            var expectedName = expectedNames[i];
            var job = jobs[i];
            var context = job.params.context;

            t.ok(job.name.indexOf(expectedName) !== -1);
            t.ok(typeof (context.params) === 'object');
            t.deepEqual(context.caller, CALLER);
        }

        t.done();
    });
};


exports.create_nonautoboot_vm = function (t) {
    var vm = {
        owner_uuid: CUSTOMER,
        image_uuid: IMAGE,
        server_uuid: SERVER.uuid,
        networks: [ { uuid: NETWORKS[0].uuid } ],
        brand: 'joyent-minimal',
        billing_id: '00000000-0000-0000-0000-000000000000',
        package_name: 'sdc_64',
        package_version: '1.0.0',
        ram: 64,
        quota: 10,
        autoboot: false
    };

    var opts = createOpts('/vms', vm);

    client.post(opts, vm, function (err, req, res, body) {
          t.ifError(err);
          t.equal(res.statusCode, 202);
          common.checkHeaders(t, res.headers);
          t.ok(body, 'vm ok');
          jobLocation = '/jobs/' + body.job_uuid;
          newUuid = body.vm_uuid;
          vmLocation = '/vms/' + newUuid;
          t.done();
    });
};


exports.get_nonautoboot_job = function (t) {
    client.get(jobLocation, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200, 'GetJob 200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'job ok');
        checkJob(t, body);
        t.done();
    });
};


exports.wait_nonautoboot_provisioned_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.change_autoboot = function (t) {
    var params = {
        action: 'update',
        autoboot: true
    };

    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_autoboot_update_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.get_nonautoboot_vm_ok = function (t) {
    var path = '/vms/' + newUuid + '?owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'vm ok');
        checkMachine(t, body);
        t.equal(body.state, 'stopped');
        t.done();
    });
};


exports.destroy_nonautoboot_vm = function (t) {
    var opts = createOpts(vmLocation);

    client.del(opts, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_nonautoboot_destroyed_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.create_vm_with_package = function (t) {
    var vm = {
        owner_uuid: CUSTOMER,
        image_uuid: IMAGE,
        server_uuid: SERVER.uuid,
        networks: [ { uuid: NETWORKS[0].uuid } ],
        brand: 'joyent-minimal',
        billing_id: pkgId
    };

    var opts = createOpts('/vms', vm);

    client.post(opts, vm, function (err, req, res, body) {
          t.ifError(err);
          t.equal(res.statusCode, 202);
          common.checkHeaders(t, res.headers);
          t.ok(body, 'vm ok');
          jobLocation = '/jobs/' + body.job_uuid;
          newUuid = body.vm_uuid;
          vmLocation = '/vms/' + newUuid;
          t.done();
    });
};


exports.wait_provisioned_with_package_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.find_new_package_ok = function (t) {
    var path = '/vms?ram=' + 256 + '&owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['x-joyent-resource-count']);
        t.ok(body);
        t.ok(Array.isArray(body));
        t.ok(body.length);
        body.forEach(function (m) {
            checkMachine(t, m);
            // Any non-null package works
            if (m['billing_id'] &&
                m['billing_id'] !== '00000000-0000-0000-0000-000000000000') {
                pkgId = m['billing_id'];
            }
        });
        t.done();
    });
};


exports.resize_package = function (t) {
    var params = { action: 'update', billing_id: pkgId };

    var opts = createOpts(vmLocation + '?force=true', params);

    client.post(opts, params, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_resize_package_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.destroy_vm_with_package = function (t) {
    var opts = createOpts(vmLocation);

    client.del(opts, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.wait_destroyed_with_package_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.provision_network_names = function (t) {
    var vm = {
        owner_uuid: CUSTOMER,
        image_uuid: IMAGE,
        server_uuid: SERVER.uuid,
        networks: [ { name: NETWORKS[0].name } ],
        brand: 'joyent-minimal',
        billing_id: '00000000-0000-0000-0000-000000000000',
        ram: 64,
        quota: 10,
        creator_uuid: CUSTOMER,
        origin: 'cloudapi'
    };

    var opts = createOpts('/vms', vm);

    client.post(opts, vm, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body, 'vm ok');

        jobLocation = '/jobs/' + body.job_uuid;
        vmLocation = '/vms/' + body.vm_uuid;
        t.done();
    });
};


exports.wait_provision_network_names = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.destroy_provision_network_name_vm = function (t) {
    var opts = createOpts(vmLocation);

    client.del(opts, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        jobLocation = '/jobs/' + body.job_uuid;
        t.done();
    });
};


exports.invalid_firewall_rules = function (t) {
    var errs = {
        enabled: 'Invalid rule: enabled must be a boolean',
        global: 'Invalid rule: cannot specify global rules',
        owner: 'Invalid rule: owner_uuid must be a UUID',
        rule: 'Invalid rule: rule must be a string',
        uuid: 'Invalid rule: uuid must be a UUID'
    };

    var owner = 'c5122cc9-5e58-4d99-bcb9-7ef8ccaaa46e';
    var rule = 'FROM any TO all vms ALLOW tcp PORT 80';
    var u = '4d71053b-8fd8-4042-88b2-fe10c7cc7055';

    var invalid = [
        [ 'asdf', 'Not an array' ],
        [ {}, 'Not an array' ],
        [ [ 'asdf' ], 'Must be an array of objects' ],

        [ [ { } ], errs.uuid ],
        [ [ { uuid: {} } ], errs.uuid ],
        [ [ { uuid: 'asdf' } ], errs.uuid ],

        [ [ { uuid: u } ], errs.rule ],
        [ [ { uuid: u, rule: {} } ], errs.rule ],

        [ [ { uuid: u, rule: rule, global: true } ], errs.global ],

        [ [ { uuid: u, rule: rule, owner_uuid: 1 } ], errs.owner ],
        [ [ { uuid: u, rule: rule, owner_uuid: {} } ], errs.owner ],
        [ [ { uuid: u, rule: rule, owner_uuid: 'asdf' } ], errs.owner ],

        [ [ { uuid: u, rule: rule, owner_uuid: owner } ], errs.enabled ],
        [ [ { uuid: u, rule: rule, owner_uuid: owner, enabled: 1 } ],
            errs.enabled ],
        [ [ { uuid: u, rule: rule, owner_uuid: owner, enabled: 'asdf' } ],
            errs.enabled ],
        [ [ { uuid: u, rule: rule, owner_uuid: owner, enabled: {} } ],
            errs.enabled ]
    ];

    async.forEachSeries(invalid, function (params, cb) {
        var vm = {
            owner_uuid: CUSTOMER,
            image_uuid: IMAGE,
            server_uuid: SERVER.uuid,
            networks: [ { name: NETWORKS[0].uuid } ],
            brand: 'joyent-minimal',
            billing_id: '00000000-0000-0000-0000-000000000000',
            ram: 64,
            quota: 10,
            creator_uuid: CUSTOMER,
            origin: 'cloudapi',
            firewall_rules: params[0]
        };

        var opts = createOpts('/vms', vm);

        client.post(opts, vm, function (err, req, res, body) {
            t.ok(err, 'error returned');
            if (err) {
                t.deepEqual(err.body, {
                    code: 'ValidationFailed',
                    message: 'Invalid VM parameters',
                    errors: [ {
                        field: 'firewall_rules',
                        code: 'Invalid',
                        message: params[1]
                    } ]
                }, 'error returned');
            }

            cb();
        });
    }, function () {
        t.done();
    });
};
