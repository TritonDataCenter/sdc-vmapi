/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

var assert = require('assert-plus');
var async = require('async');
var bunyan = require('bunyan');
var changefeed = require('changefeed');
var uuid = require('libuuid');

var common = require('./common');

var client;

var IMAGE = 'fd2cc906-8938-11e3-beab-4359c665ac99';
var CUSTOMER = common.config.ufdsAdminUuid;
var NETWORKS = null;
var SERVER = null;
var VM = null;
var CALLER = {
    type: 'signature',
    ip: '127.0.0.68',
    keyId: '/foo@joyent.com/keys/id_rsa'
};

// In seconds
var TIMEOUT = 120;

var times = 0;
var jobLocation = null;
var listenerOpts = {
    log: bunyan.createLogger({
        name: 'vmapi_test',
        level: process.env['LOG_LEVEL'] || 'error',
        stream: process.stderr
    }),
    endpoint: process.env.VMAPI_IP || '127.0.0.1',
    port: process.env.VMAPI_PORT || 80,
    instance: 'uuid goes here',
    service: 'vmapi',
    changeKind: {
        resource: 'vm',
        subResources: [
            'alias',
            'customer_metadata',
            'destroyed',
            'internal_metadata',
            'nics',
            'owner_uuid',
            'server_uuid',
            'state',
            'tags'
        ]
    }
};

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

function waitForValue(url, key, value, callback) {

    function onReady(err, ready) {
        if (err) {
            callback(err);
            return;
        }

        if (!ready) {
            times++;

            if (times === TIMEOUT) {
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
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        t.ok(servers, 'servers is set');
        t.ok(Array.isArray(servers), 'servers is Array');
        for (var i = 0; i < servers.length; i++) {
            if (servers[i].headnode === true) {
                SERVER = servers[i];
                break;
            }
        }
        t.ok(SERVER, 'server found');
        t.done();
    });
};


exports.napi_networks_ok = function (t) {
    client.napi.get('/networks', function (err, req, res, networks) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        t.ok(networks, 'networks is set');
        t.ok(Array.isArray(networks), 'networks is Array');
        t.ok(networks.length > 1, 'more than 1 network found');
        NETWORKS = networks;
        t.done();
    });
};

exports.create_vm = function (t) {
    t.expect(8);
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
        role_tags: ['fd48177c-d7c3-11e3-9330-28cfe91a33c9']
    };

    var opts = createOpts('/vms', vm);

    var listener = changefeed.createListener(listenerOpts);
    listener.register();

    listener.on('bootstrap', function () {
        client.post(opts, vm, function (err, req, res, body) {
            common.ifError(t, err);
            t.equal(res.statusCode, 202, '202 Accepted');
            common.checkHeaders(t, res.headers);
            t.ok(res.headers['workflow-api'], 'workflow-api header');
            t.ok(body, 'vm ok');

            jobLocation = '/jobs/' + body.job_uuid;
            var vmLocation = '/vms/' + body.vm_uuid;

            // GetVm should not fail after provision has been queued
            client.get(vmLocation, function (err2, req2, res2, body2) {
                common.ifError(t, err2);
                t.equal(res2.statusCode, 200, '200 OK');
                common.checkHeaders(t, res2.headers);
                t.ok(body2, 'provisioning vm ok');
                VM = body2;
            });
        });
    });

    var noStateReceived = true;
    listener.on('readable', function () {
        var changeItem = listener.read();
        var changeKind = changeItem.changeKind;
        if (noStateReceived &&
            changeItem.changedResourceId === VM.uuid &&
            changeKind.subResources &&
            changeKind.subResources.indexOf('state') !== -1) {
            t.ok(true, 'state received');
            noStateReceived = false;
            listener._endSocket();
            t.done();
        }
    });
};

exports.wait_provisioned_job = function (t) {
    t.expect(1);
    waitForValue(jobLocation, 'execution', 'succeeded', function (err) {
        common.ifError(t, err);
        t.done();
    });
};

exports.check_create_vm_nics_running = function (t) {
    t.expect(1);
    var query = {
        belongs_to_uuid: VM.uuid,
        belongs_to_type: 'zone'
    };

    waitForNicState(t, query, 'running', function (err) {
        common.ifError(t, err);
        t.done();
    });
};

exports.get_vm_ok = function (t) {
    t.expect(3);
    var path = '/vms/' + VM.uuid + '?owner_uuid=' + CUSTOMER;

    client.get(path, function (err, req, res, body) {
        common.ifError(t, err);
        t.equal(res.statusCode, 200, '200 OK');
        common.checkHeaders(t, res.headers);
        t.ok(body, 'vm ok');
        VM = body;
        t.done();
    });
};

exports.listen_for_alias = function (t) {
    t.expect(2);
    VM.alias = 'listen_for_alias';
    var opts = { path: '/vms/' + VM.uuid + '?server_uuid=' + VM.server_uuid };
    var listener = changefeed.createListener(listenerOpts);
    listener.register();

    listener.on('bootstrap', function () {
        client.put(opts, VM, function (err, req, res) {
            common.ifError(t, err);
        });
    });
    var noStateReceived = true;
    listener.on('readable', function () {
        var changeItem = listener.read();
        var changeKind = changeItem.changeKind;
        if (noStateReceived &&
            changeItem.changedResourceId === VM.uuid &&
            changeKind.subResources &&
            changeKind.subResources.indexOf('alias') !== -1) {
            t.ok(true, 'alias received');
            noStateReceived = false;
            listener._endSocket();
            t.done();
        }
    });
};

exports.listen_for_customer_metadata = function (t) {
    t.expect(2);
    VM.customer_metadata.testing = 'testing';
    var opts = { path: '/vms/' + VM.uuid + '?server_uuid=' + VM.server_uuid };
    var listener = changefeed.createListener(listenerOpts);
    listener.register();

    listener.on('bootstrap', function () {
        client.put(opts, VM, function (err, req, res) {
            common.ifError(t, err);
        });
    });
    var noStateReceived = true;
    listener.on('readable', function () {
        var changeItem = listener.read();
        var changeKind = changeItem.changeKind;
        if (noStateReceived &&
            changeItem.changedResourceId === VM.uuid &&
            changeKind.subResources &&
            changeKind.subResources.indexOf('customer_metadata') !== -1) {
            t.ok(true, 'customer_metadata received');
            noStateReceived = false;
            listener._endSocket();
            t.done();
        }
    });
};

exports.listen_for_internal_metadata = function (t) {
    t.expect(2);
    VM.internal_metadata.test = 'test';
    var opts = { path: '/vms/' + VM.uuid + '?server_uuid=' + VM.server_uuid };
    var listener = changefeed.createListener(listenerOpts);
    listener.register();

    listener.on('bootstrap', function () {
        client.put(opts, VM, function (err, req, res) {
            common.ifError(t, err);
        });
    });

    var noStateReceived = true;
    listener.on('readable', function () {
        var changeItem = listener.read();
        var changeKind = changeItem.changeKind;
        if (noStateReceived &&
            changeItem.changedResourceId === VM.uuid &&
            changeKind.subResources &&
            changeKind.subResources.indexOf('internal_metadata') !== -1) {
            t.ok(true, 'internal_metadata received');
            noStateReceived = false;
            listener._endSocket();
            t.done();
        }
    });
};

exports.listen_for_tags = function (t) {
    t.expect(2);
    VM.tags.test_tag = 'test';
    var opts = { path: '/vms/' + VM.uuid + '?server_uuid=' + VM.server_uuid };
    var listener = changefeed.createListener(listenerOpts);
    listener.register();

    listener.on('bootstrap', function () {
        client.put(opts, VM, function (err, req, res) {
            common.ifError(t, err);
        });
    });

    var noStateReceived = true;
    listener.on('readable', function () {
        var changeItem = listener.read();
        var changeKind = changeItem.changeKind;
        if (noStateReceived &&
            changeItem.changedResourceId === VM.uuid &&
            changeKind.subResources &&
            changeKind.subResources.indexOf('tags') !== -1) {
            t.ok(true, 'tags received');
            noStateReceived = false;
            listener._endSocket();
            t.done();
        }
    });
};

exports.listen_for_nics = function (t) {
    t.expect(5);
    var params = {
        action: 'add_nics',
        networks: [ { uuid: NETWORKS[1].uuid } ]
    };

    var opts = createOpts('/vms/' + VM.uuid + '?action=add_nics', params);
    var listener = changefeed.createListener(listenerOpts);
    listener.register();

    listener.on('bootstrap', function () {
        client.post(opts, params, function (err, req, res, body) {
            common.ifError(t, err);
            t.equal(res.statusCode, 202, '202 Accepted');
            common.checkHeaders(t, res.headers);
            t.ok(body, 'bootstrap body');
            t.ok(body.job_uuid, 'job_uuid: ' + body.job_uuid);
        });
    });

    var noStateReceived = true;
    listener.on('readable', function () {
        var changeItem = listener.read();
        var changeKind = changeItem.changeKind;
        if (noStateReceived &&
            changeItem.changedResourceId === VM.uuid &&
            changeKind.subResources &&
            changeKind.subResources.indexOf('nics') !== -1) {
            t.ok(true, 'nics received');
            noStateReceived = false;
            listener._endSocket();
            t.done();
        }
    });
};

exports.listen_for_stop_state = function (t) {
    t.expect(5);
    var params = {
        action: 'stop'
    };

    var opts = createOpts('/vms/' + VM.uuid + '?action=stop', params);
    var listener = changefeed.createListener(listenerOpts);
    listener.register();

    listener.on('bootstrap', function () {
        client.post(opts, params, function (err, req, res, body) {
            common.ifError(t, err);
            t.equal(res.statusCode, 202, '202 Accepted');
            common.checkHeaders(t, res.headers);
            t.ok(body, 'bootstrap body');
            t.ok(body.job_uuid, 'job_uuid: ' + body.job_uuid);
        });
    });

    var noStateReceived = true;
    listener.on('readable', function () {
        var changeItem = listener.read();
        var changeKind = changeItem.changeKind;
        if (noStateReceived &&
            changeItem.changedResourceId === VM.uuid &&
            changeKind.subResources &&
            changeKind.subResources.indexOf('state') !== -1) {
            t.ok(true, 'state received');
            listener._endSocket();
            noStateReceived = false;
            t.done();
        }
    });
};

exports.listen_for_start_state = function (t) {
    t.expect(5);
    var params = {
        action: 'start'
    };

    var opts = createOpts('/vms/' + VM.uuid + '?action=', params);
    var listener = changefeed.createListener(listenerOpts);
    listener.register();

    listener.on('bootstrap', function () {
        client.post(opts, params, function (err, req, res, body) {
            common.ifError(t, err);
            t.equal(res.statusCode, 202, '202 Accepted');
            common.checkHeaders(t, res.headers);
            t.ok(body, 'bootstrap body');
            t.ok(body.job_uuid, 'job_uuid: ' + body.job_uuid);
        });
    });
    var noStateReceived = true;
    listener.on('readable', function () {
        var changeItem = listener.read();
        var changeKind = changeItem.changeKind;
        if (noStateReceived &&
            changeItem.changedResourceId === VM.uuid &&
            changeKind.subResources &&
            changeKind.subResources.indexOf('state') !== -1) {
            t.ok(true, 'state received');
            noStateReceived = false;
            listener._endSocket();
            t.done();
        }
    });
};

exports.listen_for_reboot_state = function (t) {
    t.expect(5);
    var params = {
        action: 'reboot'
    };

    var opts = createOpts('/vms/' + VM.uuid + '?action=reboot', params);
    var listener = changefeed.createListener(listenerOpts);
    listener.register();

    listener.on('bootstrap', function () {
        client.post(opts, params, function (err, req, res, body) {
            common.ifError(t, err);
            t.equal(res.statusCode, 202, '202 Accepted');
            common.checkHeaders(t, res.headers);
            t.ok(body, 'bootstrap body');
            t.ok(body.job_uuid, 'job_uuid: ' + body.job_uuid);
        });
    });
    var noStateReceived = true;
    listener.on('readable', function () {
        var changeItem = listener.read();
        var changeKind = changeItem.changeKind;
        if (noStateReceived &&
            changeItem.changedResourceId === VM.uuid &&
            changeKind.subResources &&
            changeKind.subResources.indexOf('state') !== -1) {
            t.ok(true, 'state received');
            noStateReceived = false;
            listener._endSocket();
            t.done();
        }
    });
};

exports.listen_for_destroy = function (t) {
    t.expect(4);
    var opts = { path: '/vms/' + VM.uuid };
    var listener = changefeed.createListener(listenerOpts);
    listener.register();

    listener.on('bootstrap', function () {
        client.del(opts, function (err, req, res, body) {
            common.ifError(t, err);
            t.equal(res.statusCode, 202, '202 Accepted');
            common.checkHeaders(t, res.headers);
            t.ok(body, 'bootstrap body');
        });
    });

    var noStateReceived = true;
    listener.on('readable', function () {
        var changeItem = listener.read();
        var changeKind = changeItem.changeKind;
        if (noStateReceived &&
            changeItem.changedResourceId === VM.uuid &&
            changeKind.subResources &&
            changeKind.subResources.indexOf('destroyed') !== -1) {
            t.ok(true, 'destroyed received');
            noStateReceived = false;
            listener._endSocket();
            t.done();
        }
    });
};

exports.put_new_vm = function (t) {
    t.expect(2);
    var vm = VM;
    vm.alias = 'garbage' + uuid.create();
    vm.uuid = uuid.create();
    var opts = { path: '/vms/' + vm.uuid };

    client.put(opts, vm, function (err, req, res) {
        common.ifError(t, err);
        vm.state = 'destroyed';
        client.put(opts, vm, function (err2, req2, res2) {
            common.ifError(t, err2);
            t.done();
        });
    });

};

exports.put_new_vms = function (t) {
    t.expect(2);
    var vm = VM;
    vm.alias = 'garbage' + uuid.create();
    vm.uuid = uuid.create();
    var query = { server_uuid: SERVER.uuid };
    var opts = { path: '/vms', query: query };
    var vms = {};
    vms[vm.uuid] = vm;
    client.put(opts, { vms: vms }, function (err, req, res) {
        common.ifError(t, err);
        vms[vm.uuid].state = 'destroyed';
        client.put(opts, { vms: vms }, function (err2, req2, res2) {
            common.ifError(t, err2);
            t.done();
        });
    });

};
