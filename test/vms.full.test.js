/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

// var test = require('tap').test;
var assert = require('assert-plus');
var uuid = require('libuuid');
var qs = require('querystring');
var async = require('async');

var common = require('./common');

var workflow = require('./lib/workflow');

// --- Globals

var client;
var muuid;
var newUuid;
var jobLocation;
var vmLocation;
var vmCount;
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

// --- Helpers

function checkMachine(t, vm) {
    t.ok(vm.uuid, 'uuid');
    t.ok(vm.brand, 'brand');
    t.ok(vm.ram, 'ram');
    t.ok(vm.max_swap, 'swap');
    t.ok(vm.cpu_shares, 'cpu shares');
    t.ok(vm.max_lwps, 'lwps');
    t.ok(vm.create_timestamp, 'create timestamp');
    t.ok(vm.state, 'state');
    t.ok(vm.zfs_io_priority, 'zfs io');
    t.ok(vm.owner_uuid, 'owner uuid');

    // Question: why is quota null when the VM state is destroyed (unlike, say,
    // ram). Shouldn't this be persisted into destruction?
    if (vm.state && vm.state !== 'destroyed') {
        t.ok(vm.quota, 'disk');
    }
}


function waitForNicState(t, query, state, waitCallback) {
    var stop = false;
    var count = 0;
    var maxSeconds = 60;

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


exports.filter_vms_predicate = function (t) {
    var pred  = JSON.stringify({ eq: [ 'brand', 'joyent-minimal' ] });
    var path = '/vms?predicate=' + pred;

    client.get(path, function (err, req, res, body) {
        t.ifError(err);

        t.equal(res.statusCode, 200);
        common.checkHeaders(t, res.headers);

        t.ok(res.headers['x-joyent-resource-count']);
        t.ok(body);
        t.ok(Array.isArray(body));
        t.ok(body.length);

        body.forEach(function (m) {
            t.equal(m.brand, 'joyent-minimal');
        });

        t.done();
    });
};


exports.filter_vms_mixed = function (t) {
    var query = qs.escape('(ram=128)');
    var pred  = JSON.stringify({ eq: [ 'brand', 'joyent-minimal' ] });
    var args  = 'owner_uuid=' + CUSTOMER;

    var path = '/vms?query=' + query + '&predicate=' + pred + '&' + args;

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
            t.equal(m.owner_uuid, CUSTOMER);
            t.equal(m.max_physical_memory, 128);
            t.equal(m.brand, 'joyent-minimal');
        });

        // Being extra safe here; if owner_uuid is ignored, then we get
        // vulnerabilities. Check with a non-existent owner_uuid:
        var badArgs = 'owner_uuid=ba4c20e0-a732-4abe-a185-8f76101e6b90';
        path = '/vms?query=' + query + '&predicate=' + pred + '&' + badArgs;

        client.get(path, function (err2, req2, res2, body2) {
            t.ifError(err2);

            t.equal(res2.statusCode, 200);
            t.ok(Array.isArray(body2));
            t.equal(body2.length, 0);

            t.done();
        });
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
        vmCount = res.headers['x-joyent-resource-count'];
        t.done();
    });
};


exports.offset_vms_ok = function (t) {
    var path = '/vms?ram=' + 128 + '&owner_uuid=' + CUSTOMER + '&offset=2';

    client.get(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['x-joyent-resource-count']);
        t.ok(body);
        t.ok(Array.isArray(body));
        t.equal(body.length, vmCount - 2);
        t.done();
    });
};


exports.offset_vms_at_end = function (t) {
    var path = '/vms?ram=' + 128 + '&owner_uuid=' + CUSTOMER +
        '&offset=' + vmCount;

    client.get(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        t.ok(Array.isArray(body));
        t.equal(body.length, 0);
        t.done();
    });
};


exports.offset_vms_beyond = function (t) {
    var path = '/vms?ram=' + 128 + '&owner_uuid=' + CUSTOMER +
        '&offset=' + vmCount + 5;

    client.get(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        t.ok(Array.isArray(body));
        t.equal(body.length, 0);
        t.done();
    });
};


exports.offset_fields_vms_ok = function (t) {
    // Currently we get lucky because the dhcpd0 and assets0 zones
    // are 128MBs zones
    var path = '/vms?ram=' + 128 + '&owner_uuid=' + CUSTOMER +
        '&fields=uuid,alias&offset=1';

    client.get(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        common.checkHeaders(t, res.headers);
        t.ok(res.headers['x-joyent-resource-count']);
        t.ok(body);
        t.ok(Array.isArray(body));
        t.equal(body.length, vmCount - 1);
        // TODO: this should not depend on the number of VMs, instead
        // we should create a known specific number of VMs as a setup step
        // for this test. Thus we would know that we have at least one VM
        // in the response
        if (body.length > 0) {
            t.notStrictEqual(body[0].uuid, undefined);
            t.notStrictEqual(body[0].alias, undefined);
            t.strictEqual(body[0].ram, undefined);
        }
        t.done();
    });
};


exports.offset_fields_vms_beyond = function (t) {
    var path = '/vms?ram=' + 128 + '&owner_uuid=' + CUSTOMER +
        '&fields=uuid,alias&offset=' + vmCount + 5;

    client.get(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        common.checkHeaders(t, res.headers);
        t.ok(body);
        t.ok(Array.isArray(body));
        t.equal(body.length, 0);
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


exports.create_vm_tags_not_ok = function (t) {
    function callVmapi(tags, expectedErr, next) {
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
            origin: 'cloudapi',
            role_tags: ['fd48177c-d7c3-11e3-9330-28cfe91a33c9'],
            tags: tags
        };

        var opts = createOpts('/vms', vm);
        client.post(opts, vm, function (err, req, res, body) {
            t.ok(err);
            t.equal(err.restCode, 'ValidationFailed');
            t.equal(err.message, 'Invalid VM parameters');
            t.equal(res.statusCode, 409);

            t.deepEqual(body, {
                code: 'ValidationFailed',
                message: 'Invalid VM parameters',
                errors: [ {
                    field: 'tags',
                    code: 'Invalid',
                    message: expectedErr
                } ]
            });

            next();
        });
    }

    function checkBadTritonTag(next) {
        var msg = 'Unrecognized special triton tag "triton.foo"';
        callVmapi({ 'triton.foo': true }, msg, next);
    }

    function checkBadTritonTagType1(next) {
        var msg = '"triton.cns.services" must be a string';
        callVmapi({ 'triton.cns.services': true }, msg, next);
    }

    function checkBadTritonTagType2(next) {
        var msg = '"triton.cns.disable" must be a boolean';
        callVmapi({ 'triton.cns.disable': 'true' }, msg, next);
    }

    function checkBadTritonDNS(next) {
        var msg = '"_foo.bar" is not DNS safe';
        callVmapi({ 'triton.cns.services': 'foo,_foo.bar' }, msg, next);
    }

    async.series([
        checkBadTritonTag, checkBadTritonTagType1, checkBadTritonTagType2,
        checkBadTritonDNS
    ], function () {
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
        workflow.checkJob(t, body);
        t.done();
    });
};


exports.wait_provisioned_job = function (t) {
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
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
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
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
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
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
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
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
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
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
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
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
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
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


exports.change_with_bad_tags = function (t) {
    function action(tags, expectedErr, next) {
        var params = {
            action: 'update',
            tags: tags
        };

        var opts = createOpts(vmLocation, params);

        client.post(opts, params, function (err, req, res, body) {
            t.ok(err);
            t.equal(err.restCode, 'ValidationFailed');
            t.equal(err.message, 'Invalid VM update parameters');
            t.equal(res.statusCode, 409);

            t.deepEqual(body, {
                code: 'ValidationFailed',
                message: 'Invalid VM update parameters',
                errors: [ {
                    field: 'tags',
                    code: 'Invalid',
                    message: expectedErr
                } ]
            });

            next();
        });
    }

    function call(method, tags, expectedErr, next) {
        var path = '/vms/' + newUuid + '/tags';
        var opts = createOpts(path, tags);

        client[method](opts, tags, function (err, req, res, body) {
            t.ok(err);
            t.equal(err.restCode, 'ValidationFailed');
            t.equal(err.message, 'Invalid Metadata parameters');
            t.equal(res.statusCode, 409);

            t.deepEqual(body, {
                code: 'ValidationFailed',
                message: 'Invalid Metadata parameters',
                errors: [ {
                    field: 'tags',
                    code: 'Invalid',
                    message: expectedErr
                } ]
            });

            next();
        });
    }

    var unrecognizedMsg = 'Unrecognized special triton tag "triton.foo"';
    var stringMsg = '"triton.cns.services" must be a string';
    var booleanMsg = '"triton.cns.disable" must be a boolean';
    var dnsMsg = '"_foo.bar" is not DNS safe';
    var dockerMsg = 'Special tag "docker:label:com.docker." not supported';

    function actionBadTritonTag(next) {
        action({ 'triton.foo': true }, unrecognizedMsg, next);
    }

    function actionBadTritonTagType1(next) {
        action({ 'triton.cns.services': true }, stringMsg, next);
    }

    function actionBadTritonTagType2(next) {
        action({ 'triton.cns.disable': 'true' }, booleanMsg, next);
    }

    function actionBadTritonDNS(next) {
        action({ 'triton.cns.services': 'foo,_foo.bar' }, dnsMsg, next);
    }

    function actionBadReservedDockerTag(next) {
        action({ 'docker:label:com.docker.': 'foo,_foo.bar' }, dockerMsg, next);
    }

    function postBadTritonTag(next) {
        call('post', { 'triton.foo': true }, unrecognizedMsg, next);
    }

    function postBadTritonTagType1(next) {
        call('post', { 'triton.cns.services': true }, stringMsg, next);
    }

    function postBadTritonTagType2(next) {
        call('post', { 'triton.cns.disable': 'true' }, booleanMsg, next);
    }

    function postBadTritonDNS(next) {
        call('post', { 'triton.cns.services': 'foo,_foo.bar' }, dnsMsg, next);
    }

    function postBadReservedDockerTag(next) {
        call('post', { 'docker:label:com.docker.': 'foo,_foo.bar' }, dockerMsg,
            next);
    }

    function putBadTritonTag(next) {
        call('put', { 'triton.foo': true }, unrecognizedMsg, next);
    }

    function putBadTritonTagType1(next) {
        call('put', { 'triton.cns.services': true }, stringMsg, next);
    }

    function putBadTritonTagType2(next) {
        call('put', { 'triton.cns.disable': 'true' }, booleanMsg, next);
    }

    function putBadTritonDNS(next) {
        call('put', { 'triton.cns.services': 'foo,_foo.bar' }, dnsMsg, next);
    }

    function putBadReservedDockerTag(next) {
        call('put', { 'docker:label:com.docker.': 'foo,_foo.bar' }, dockerMsg,
            next);
    }

    async.series([
        actionBadTritonTag, actionBadTritonTagType1, actionBadTritonTagType2,
        actionBadTritonDNS, postBadTritonTag, postBadTritonTagType1,
        postBadTritonTagType2, postBadTritonDNS, putBadTritonTag,
        putBadTritonTagType1, putBadTritonTagType2, putBadTritonDNS,
        actionBadReservedDockerTag, postBadReservedDockerTag,
        putBadReservedDockerTag
    ], function () {
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
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
            t.ifError(err);
            t.done();
        });
};


exports.wait_new_tag = function (t) {
    var tags = {
        role: 'database',
        group: 'deployment'
    };

    workflow.waitForValue(client, vmLocation, 'tags', tags, function (err) {
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
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
            t.ifError(err);
            t.done();
        });
};


exports.wait_delete_tag = function (t) {
    var tags = {
        group: 'deployment'
    };

    workflow.waitForValue(client, vmLocation, 'tags', tags, function (err) {
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
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
            t.ifError(err);
            t.done();
        });
};


exports.wait_delete_tags = function (t) {
    workflow.waitForValue(client, vmLocation, 'tags', {}, function (err) {
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
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
            t.ifError(err);
            t.done();
        });
};


exports.wait_set_tags = function (t) {
    var tags = {
        role: 'database',
        group: 'deployment'
    };

    workflow.waitForValue(client, vmLocation, 'tags', tags, function (err) {
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
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
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
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
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
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
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
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
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
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
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
        workflow.checkJob(t, body);
        t.done();
    });
};


exports.wait_nonautoboot_provisioned_job = function (t) {
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
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
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
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
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
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
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
            t.ifError(err);
            t.done();
        });
};


// if there's not enough spare RAM on a server, and we're resizing upwards, we
// want it to fail
exports.resize_package_up_fail = function (t) {
    if (SERVER.datacenter !== 'coal' || !SERVER.headnode)
        return t.done();

    var path = '/vms?ram=' + 1024 + '&owner_uuid=' + CUSTOMER;
    var largerPkg;

    client.get(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        body.forEach(function (m) {
            // Any non-null package works
            if (m['billing_id'] &&
                m['billing_id'] !== '00000000-0000-0000-0000-000000000000') {
                largerPkg = m['billing_id'];
            }
        });

        var params = { action: 'update', billing_id: largerPkg };

        var opts = createOpts(vmLocation, params);

        return client.post(opts, params, function (err2, req2, res2, body2) {
            t.ok(err2);
            t.equal(res2.statusCode, 409);

            t.equal(body2.code, 'ValidationFailed');
            t.equal(body2.message, 'Invalid VM update parameters');

            var error = body2.errors[0];
            t.equal(error.field, 'ram');
            t.equal(error.code, 'InsufficientCapacity');
            t.ok(error.message.match('Required additional RAM \\(896\\) ' +
                'exceeds the server\'s available RAM \\(-\\d+\\)'));

            t.done();
        });
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
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
            t.ifError(err);
            t.done();
        });
};


// regardless of spare RAM on server, we always want resizing down to succeed
exports.resize_package_down = function (t) {
    var path = '/vms?ram=' + 128 + '&owner_uuid=' + CUSTOMER;
    var smallerPkg;

    client.get(path, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 200);
        body.forEach(function (m) {
            // Any non-null package works
            if (m['billing_id'] &&
                m['billing_id'] !== '00000000-0000-0000-0000-000000000000') {
                smallerPkg = m['billing_id'];
            }
        });

        var params = { action: 'update', billing_id: smallerPkg };

        var opts = createOpts(vmLocation, params);

        return client.post(opts, params, function (err2, req2, res2, body2) {
            t.ifError(err2);
            t.equal(res.statusCode, 200);
            jobLocation = '/jobs/' + body2.job_uuid;
            t.done();
        });
    });
};


exports.wait_resize_package_job_2 = function (t) {
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
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
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
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
    workflow.waitForValue(client, jobLocation, 'execution', 'succeeded',
        function (err) {
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
        [ [ 'asdf' ], 'Not an array of objects' ],

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


exports.create_docker_vm = function (t) {
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
        origin: 'cloudapi',
        tags: {
           'docker:label:com.docker.blah': 'quux'
        }
    };

    var opts = createOpts('/vms', vm);

    client.post(opts, vm, function (err, req, res, body) {
        t.ifError(err);
        t.equal(res.statusCode, 202);

        jobLocation = '/jobs/' + body.job_uuid;
        newUuid = body.vm_uuid;
        vmLocation = '/vms/' + newUuid;

        t.done();
    });
};


exports.wait_provisioned_docker_job = function (t) {
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        t.ifError(err);
        t.done();
    });
};


exports.add_docker_tag = function (t) {
    var path = '/vms/' + newUuid + '/tags?owner_uuid=' + CUSTOMER;

    var query = {
        'foo': 'bar',
        'docker:label:com.docker.blah': 'baz'
    };

    var opts = createOpts(path, query);

    client.post(opts, query, function (err, req, res, body) {
        t.ok(err);
        t.equal(res.statusCode, 409);
        t.equal(err.restCode, 'ValidationFailed');
        t.deepEqual(body, {
            code: 'ValidationFailed',
            message: 'Invalid Metadata parameters',
            errors: [ {
                field: 'tags',
                code: 'Invalid',
                message: 'Special tag "docker:label:com.docker.blah" ' +
                    'not supported'
            } ]
        });

        t.done();
    });
};


exports.set_docker_tag_1 = function (t) {
    var path = '/vms/' + newUuid + '/tags?owner_uuid=' + CUSTOMER;

    var query = {
        'foo': 'bar',
        'docker:label:com.docker.blah': 'baz'
    };

    var opts = createOpts(path, query);

    client.put(opts, query, function (err, req, res, body) {
        t.ok(err);
        t.equal(res.statusCode, 409);
        t.equal(err.restCode, 'ValidationFailed');

        t.deepEqual(body, {
            code: 'ValidationFailed',
            message: 'Invalid Metadata parameters',
            errors: [ {
                field: 'tags',
                code: 'Invalid',
                message: 'Special tag "docker:label:com.docker.blah" not ' +
                    'supported'
            } ]
        });

        t.done();
    });
};


exports.set_docker_tag_2 = function (t) {
    var path = '/vms/' + newUuid + '/tags?owner_uuid=' + CUSTOMER;

    var query = {
       foo: 'bar'
    };

    var opts = createOpts(path, query);

    client.put(opts, query, function (err, req, res, body) {
        t.ok(err);
        t.equal(res.statusCode, 409);
        t.equal(err.restCode, 'ValidationFailed');

        t.deepEqual(body, {
            code: 'ValidationFailed',
            message: 'Invalid Metadata parameters',
            errors: [ {
                field: 'tags',
                code: 'Invalid',
                message: 'Special tag "docker:label:com.docker.blah" may ' +
                    'not be deleted'
            } ]
        });

        t.done();
    });
};


exports.update_docker_vm = function (t) {
    var params = {
        action: 'update',
        tags: {
            foo: 'bar'
        }
    };

    var opts = createOpts(vmLocation, params);

    client.post(opts, params, function (err, req, res, body) {
        t.ok(err);
        t.equal(res.statusCode, 409);
        t.equal(err.restCode, 'ValidationFailed');

        t.deepEqual(body, {
            code: 'ValidationFailed',
            message: 'Invalid VM update parameters',
            errors: [ {
                field: 'tags',
                code: 'Invalid',
                message: 'Special tag "docker:label:com.docker.blah" may ' +
                    'not be deleted'
            } ]
        });

        t.done();
    });
};


exports.delete_docker_tag = function (t) {
    var path = '/vms/' + newUuid + '/tags/docker%3Alabel%3Acom.docker.blah' +
        '?owner_uuid=' + CUSTOMER;

    var opts = createOpts(path, { owner_uuid: CUSTOMER });

    client.del(opts, function (err, req, res, body) {
        t.ok(err);
        t.equal(res.statusCode, 409);
        t.equal(err.restCode, 'ValidationFailed');

        t.deepEqual(body, {
            code: 'ValidationFailed',
            message: 'Invalid Metadata parameters',
            errors: [ {
                field: 'tags',
                code: 'Invalid',
                message: 'Special tag "docker:label:com.docker.blah" may ' +
                    'not be deleted'
            } ]
        });

        t.done();
    });
};


exports.delete_docker_all_tags = function (t) {
    var path = '/vms/' + newUuid + '/tags?owner_uuid=' + CUSTOMER;

    var opts = createOpts(path, { owner_uuid: CUSTOMER });

    client.del(opts, function (err, req, res, body) {
        t.ok(err);
        t.equal(res.statusCode, 409);
        t.equal(err.restCode, 'ValidationFailed');

        t.deepEqual(body, {
            code: 'ValidationFailed',
            message: 'Invalid Metadata parameters',
            errors: [ {
                field: 'tags',
                code: 'Invalid',
                message: 'Special tag "docker:label:com.docker.blah" may ' +
                    'not be deleted'
            } ]
        });

        t.done();
    });
};


exports.destroy_docker_vm = function (t) {
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
