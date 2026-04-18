/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2026 Edgecast Cloud LLC.
 */

/*
 * Workflow tasks for bhyve live migration.
 *
 * Each task posts `{action: 'live-*'}` to CNAPI's
 * POST /servers/:s/vms/:v/migrate, which forks cn-agent's
 * machine-migrate-live.js.  That child talks to the per-CN
 * vmm-migrate-agent Unix socket and returns a terminal state.
 * The workflow then waits on the CNAPI task with
 * migrationCommon.tasks.waitTask.
 *
 * The four task bodies below (liveBegin/Sync/Switch/Abort) look
 * near-identical on purpose.  wfapi runs each body in its own
 * evalmachine sandbox, serialised from .toString(), so closure-capture
 * over a factory function would not survive the upload.  We pay for
 * DRY at runtime (one sandbox per task) by repeating the boilerplate
 * in source.
 */


var assert = require('assert-plus');
var restify = require('restify');


function liveBegin(job, cb) {
    var record = job.params.migrationTask.record;

    assert.object(job.params.vm, 'job.params.vm');
    assert.uuid(record.source_server_uuid, 'record.source_server_uuid');
    assert.uuid(record.target_server_uuid, 'record.target_server_uuid');
    assert.string(record.target_admin_ip, 'record.target_admin_ip');

    job.endpoint = '/servers/' + record.source_server_uuid +
        '/vms/' + record.vm_uuid + '/migrate';
    job.action = 'migrate';
    job.params.action = 'live-begin';
    // The cn-agent child needs to know where to tell the source
    // vmm-migrate-agent to connect.  The target admin IP is stashed
    // on the record by an earlier workflow step (lookupTargetAdminIp).
    job.params.target_admin_ip = record.target_admin_ip;

    // 60s is the upper bound for the wire-up call that enqueues a
    // CNAPI task.  The task itself can take much longer and is waited
    // on via waitTask in the workflow chain.  (Inlined per task body:
    // workflow-task evalmachine has no module-scope closure.)
    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: {'x-request-id': job.params['x-request-id']},
        connectTimeout: 60 * 1000,
        requestTimeout: 60 * 1000
    });

    cnapi.post(job.endpoint, job.params, function (err, req, res, task) {
        if (err) { cb(err); return; }
        job.taskId = task.id;
        cb(null, 'live-begin task queued to CNAPI: ' + task.id);
    });
}


function liveSync(job, cb) {
    var record = job.params.migrationTask.record;

    assert.uuid(record.source_server_uuid, 'record.source_server_uuid');

    job.endpoint = '/servers/' + record.source_server_uuid +
        '/vms/' + record.vm_uuid + '/migrate';
    job.action = 'migrate';
    job.params.action = 'live-sync';

    // 60s is the upper bound for the wire-up call that enqueues a
    // CNAPI task.  The task itself can take much longer and is waited
    // on via waitTask in the workflow chain.  (Inlined per task body:
    // workflow-task evalmachine has no module-scope closure.)
    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: {'x-request-id': job.params['x-request-id']},
        connectTimeout: 60 * 1000,
        requestTimeout: 60 * 1000
    });

    cnapi.post(job.endpoint, job.params, function (err, req, res, task) {
        if (err) { cb(err); return; }
        job.taskId = task.id;
        cb(null, 'live-sync task queued to CNAPI: ' + task.id);
    });
}


function liveSwitch(job, cb) {
    var record = job.params.migrationTask.record;

    assert.uuid(record.source_server_uuid, 'record.source_server_uuid');

    job.endpoint = '/servers/' + record.source_server_uuid +
        '/vms/' + record.vm_uuid + '/migrate';
    job.action = 'migrate';
    job.params.action = 'live-switch';

    // 60s is the upper bound for the wire-up call that enqueues a
    // CNAPI task.  The task itself can take much longer and is waited
    // on via waitTask in the workflow chain.  (Inlined per task body:
    // workflow-task evalmachine has no module-scope closure.)
    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: {'x-request-id': job.params['x-request-id']},
        connectTimeout: 60 * 1000,
        requestTimeout: 60 * 1000
    });

    cnapi.post(job.endpoint, job.params, function (err, req, res, task) {
        if (err) { cb(err); return; }
        job.taskId = task.id;
        cb(null, 'live-switch task queued to CNAPI: ' + task.id);
    });
}


function liveAbort(job, cb) {
    var record = job.params.migrationTask.record;

    assert.uuid(record.source_server_uuid, 'record.source_server_uuid');

    job.endpoint = '/servers/' + record.source_server_uuid +
        '/vms/' + record.vm_uuid + '/migrate';
    job.action = 'migrate';
    job.params.action = 'live-abort';

    // 60s is the upper bound for the wire-up call that enqueues a
    // CNAPI task.  The task itself can take much longer and is waited
    // on via waitTask in the workflow chain.  (Inlined per task body:
    // workflow-task evalmachine has no module-scope closure.)
    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: {'x-request-id': job.params['x-request-id']},
        connectTimeout: 60 * 1000,
        requestTimeout: 60 * 1000
    });

    cnapi.post(job.endpoint, job.params, function (err, req, res, task) {
        if (err) { cb(err); return; }
        job.taskId = task.id;
        cb(null, 'live-abort task queued to CNAPI: ' + task.id);
    });
}


/*
 * Resolve source and target admin IPs (via CNAPI) and the guest's
 * primary NIC IP (from the VM object), and stash all three on the
 * migration record.  Needed by:
 *   - liveBegin: uses target_admin_ip as the 'dest' arg for the
 *     vmm-migrate-agent's migrate-begin command.
 *   - vmm-migrate-viz and operator tooling: read source_admin_ip
 *     to connect to the source agent's SSE event stream, and
 *     guest_primary_ip for the in-guest connectivity probe.
 *
 * Resolving all three in one task keeps the workflow linear and
 * avoids a separate CNAPI round-trip per field.
 */
function resolveAgentEndpoints(job, cb) {
    var record = job.params.migrationTask.record;
    assert.uuid(record.source_server_uuid, 'record.source_server_uuid');
    assert.uuid(record.target_server_uuid, 'record.target_server_uuid');
    assert.object(job.params.vm, 'job.params.vm');

    // 60s is the upper bound for the wire-up call that enqueues a
    // CNAPI task.  The task itself can take much longer and is waited
    // on via waitTask in the workflow chain.  (Inlined per task body:
    // workflow-task evalmachine has no module-scope closure.)
    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: {'x-request-id': job.params['x-request-id']},
        connectTimeout: 60 * 1000,
        requestTimeout: 60 * 1000
    });

    // Pick the admin-tagged NIC's ip4addr from a CNAPI server sysinfo.
    // Admin NIC identification lives inside each iface's 'NIC Names'.
    function adminIpFromSysinfo(server) {
        var ifaces = (server && server.sysinfo &&
            server.sysinfo['Network Interfaces']) || {};
        var names = Object.keys(ifaces);
        for (var i = 0; i < names.length; i++) {
            var iface = ifaces[names[i]] || {};
            var tags = iface['NIC Names'] || [];
            if (tags.indexOf('admin') !== -1 && iface['ip4addr']) {
                return iface['ip4addr'];
            }
        }
        return null;
    }

    function fetchAdminIp(server_uuid, next) {
        cnapi.get('/servers/' + server_uuid, function (err, _r, _s, srv) {
            if (err) { next(err); return; }
            var ip = adminIpFromSysinfo(srv);
            if (!ip) {
                next(new Error('No admin NIC found for server ' + server_uuid));
                return;
            }
            next(null, ip);
        });
    }

    // Guest primary IP from the VM record (prefer nic.primary).  This is
    // what vmm-migrate-viz uses for its in-guest connectivity probe.
    var nics = job.params.vm.nics || [];
    var primaryNic = nics.filter(function (n) { return n.primary; })[0];
    var guestIp = (primaryNic && primaryNic.ip) ||
        (nics[0] && nics[0].ip) || null;
    if (guestIp) {
        record.guest_primary_ip = guestIp;
    }

    // Resolve source and target admin IPs serially.  Both go on the
    // migration record and downstream code (liveBegin, cn-agent child)
    // consumes target_admin_ip as the peer the source agent connects
    // to.  A mix-up here is catastrophic — the source agent would
    // destroy its own zvols thinking they were the remote.  Fetching
    // in a known sequence and assigning directly is far safer than a
    // parallel-with-index-by-completion pattern.
    fetchAdminIp(record.source_server_uuid, function (srcErr, sourceIp) {
        if (srcErr) { cb(srcErr); return; }
        record.source_admin_ip = sourceIp;

        fetchAdminIp(record.target_server_uuid, function (dstErr, targetIp) {
            if (dstErr) { cb(dstErr); return; }
            record.target_admin_ip = targetIp;
            cb(null, 'agent endpoints: source=' + sourceIp +
                ' target=' + targetIp +
                (guestIp ? ' guest=' + guestIp : ''));
        });
    });
}


module.exports = {
    tasks: {
        liveBegin: {
            name: 'migration.liveBegin',
            timeout: 60 * 60, // 1 hour for initial full zfs send
            retry: 1,
            body: liveBegin,
            modules: {
                assert: 'assert-plus',
                restify: 'restify',
                vasync: 'vasync'
            }
        },
        liveSync: {
            name: 'migration.liveSync',
            timeout: 30 * 60,
            retry: 1,
            body: liveSync,
            modules: {
                assert: 'assert-plus',
                restify: 'restify',
                vasync: 'vasync'
            }
        },
        liveSwitch: {
            name: 'migration.liveSwitch',
            timeout: 15 * 60,
            retry: 1,
            body: liveSwitch,
            modules: {
                assert: 'assert-plus',
                restify: 'restify',
                vasync: 'vasync'
            }
        },
        liveAbort: {
            name: 'migration.liveAbort',
            timeout: 2 * 60,
            retry: 1,
            body: liveAbort,
            modules: {
                assert: 'assert-plus',
                restify: 'restify',
                vasync: 'vasync'
            }
        },
        resolveAgentEndpoints: {
            name: 'migration.resolveAgentEndpoints',
            timeout: 60,
            retry: 2,
            body: resolveAgentEndpoints,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        }
    }
};
