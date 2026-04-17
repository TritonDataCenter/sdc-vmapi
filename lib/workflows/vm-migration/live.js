/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2026 MNX Cloud, Inc.
 */

/*
 * Workflow tasks for bhyve live migration.
 *
 * These are the VMAPI-workflow-side counterparts to the cn-agent
 * bin/machine-migrate-live.js child.  Each task posts one
 * `{action: 'live-*'}` payload to CNAPI's
 * POST /servers/:s/vms/:v/migrate endpoint, which causes cn-agent to
 * fork machine-migrate-live.js; that child forwards to the per-CN
 * vmm-migrate-agent's Unix socket, waits for a terminal state, and
 * returns the result via IPC.  The workflow then waits on the CNAPI
 * task to complete in the usual way (migrationCommon.tasks.waitTask).
 *
 * These tasks deliberately mirror the shape of the cold-migration
 * tasks in common.js (same job.endpoint / job.params.action /
 * cnapi.post + job.taskId handoff).  The difference is which cn-agent
 * action verb they post, and which migration-record fields they
 * consult.
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

    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: {'x-request-id': job.params['x-request-id']}
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

    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: {'x-request-id': job.params['x-request-id']}
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

    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: {'x-request-id': job.params['x-request-id']}
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

    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: {'x-request-id': job.params['x-request-id']}
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

    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: {'x-request-id': job.params['x-request-id']}
    });

    // Helper: pick the admin-tagged NIC's ip4addr from a CNAPI server
    // sysinfo response.  Worth spelling out explicitly because the
    // sysinfo 'Network Interfaces' shape is keyed by iface name and
    // the admin NIC's identification lives inside the iface object's
    // 'NIC Names' list.
    function adminIpFromSysinfo(server) {
        var ifaces = (server && server.sysinfo &&
            server.sysinfo['Network Interfaces']) || {};
        var ip = null;
        Object.keys(ifaces).forEach(function (ifname) {
            var iface = ifaces[ifname];
            var tags = iface['NIC Names'] || [];
            if (tags.indexOf('admin') !== -1 && iface['ip4addr']) {
                ip = iface['ip4addr'];
            }
        });
        return ip;
    }

    // Guest primary IP: prefer the NIC marked primary, else the first
    // NIC with an ip.  This is what vmm-migrate-viz feeds its
    // connectivity probe on the guest.
    var nics = job.params.vm.nics || [];
    var primaryNic = nics.filter(function (n) { return n.primary; })[0];
    var guestIp = (primaryNic && primaryNic.ip) ||
        (nics[0] && nics[0].ip) || null;
    if (guestIp) {
        record.guest_primary_ip = guestIp;
    }

    cnapi.get('/servers/' + record.source_server_uuid,
        function (err, cReq, cRes, sourceServer) {
        if (err) { cb(err); return; }
        var sourceIp = adminIpFromSysinfo(sourceServer);
        if (!sourceIp) {
            cb('No admin NIC found for source server ' +
                record.source_server_uuid);
            return;
        }
        record.source_admin_ip = sourceIp;

        cnapi.get('/servers/' + record.target_server_uuid,
            function (err2, c2Req, c2Res, targetServer) {
            if (err2) { cb(err2); return; }
            var targetIp = adminIpFromSysinfo(targetServer);
            if (!targetIp) {
                cb('No admin NIC found for target server ' +
                    record.target_server_uuid);
                return;
            }
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
                restify: 'restify'
            }
        },
        liveSync: {
            name: 'migration.liveSync',
            timeout: 30 * 60,
            retry: 1,
            body: liveSync,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        liveSwitch: {
            name: 'migration.liveSwitch',
            timeout: 15 * 60,
            retry: 1,
            body: liveSwitch,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        },
        liveAbort: {
            name: 'migration.liveAbort',
            timeout: 2 * 60,
            retry: 1,
            body: liveAbort,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
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
