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
 * Resolve target_server_uuid -> target_admin_ip via CNAPI, and stash it
 * on the migration record.  Needed by liveBegin so the source
 * vmm-migrate-agent knows where to open the peer TCP connection
 * (port 4567 by convention).
 */
function lookupTargetAdminIp(job, cb) {
    var record = job.params.migrationTask.record;
    assert.uuid(record.target_server_uuid, 'record.target_server_uuid');

    var cnapi = restify.createJsonClient({
        url: cnapiUrl,
        headers: {'x-request-id': job.params['x-request-id']}
    });

    cnapi.get('/servers/' + record.target_server_uuid,
        function (err, cReq, cRes, server) {
        if (err) { cb(err); return; }
        if (!server || !server.sysinfo) {
            cb('CNAPI returned no sysinfo for server ' +
                record.target_server_uuid);
            return;
        }
        // Admin IP is on the NIC tagged admin.  sysinfo['Network Interfaces']
        // keys by iface name; we look for the one with NIC Names containing
        // 'admin'.  (Kept explicit; worth a comment because the sysinfo
        // shape has tripped people up before.)
        var ifaces = server.sysinfo['Network Interfaces'] || {};
        var adminIp = null;
        Object.keys(ifaces).forEach(function (ifname) {
            var iface = ifaces[ifname];
            var tags = iface['NIC Names'] || [];
            if (tags.indexOf('admin') !== -1 && iface['ip4addr']) {
                adminIp = iface['ip4addr'];
            }
        });
        if (!adminIp) {
            cb('No admin NIC found for target server ' +
                record.target_server_uuid);
            return;
        }
        record.target_admin_ip = adminIp;
        cb(null, 'target admin IP: ' + adminIp);
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
        lookupTargetAdminIp: {
            name: 'migration.lookupTargetAdminIp',
            timeout: 60,
            retry: 2,
            body: lookupTargetAdminIp,
            modules: {
                assert: 'assert-plus',
                restify: 'restify'
            }
        }
    }
};
