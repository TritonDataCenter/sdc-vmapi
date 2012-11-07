/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


// This is not really needed, but javascriptlint will complain otherwise:
var sdcClients = require('sdc-clients');
var common = require('./job-common');

var VERSION = '7.0.0';

function setupRequest(job, cb) {
    job.endpoint = '/servers/' +
                   job.params['server_uuid'] + '/vms/' +
                   job.params['vm_uuid'] + '/update';
    job.params.jobid = job.uuid;
    job.requestMethod = 'post';

    return cb(null, 'Request has been setup!');
}



function updateCustomerVm(job, cb) {
    var dn = 'vm=' + job.params['vm_uuid'] + ', uuid=' +
            job.params['owner_uuid'] + ', ou=users, o=smartdc';
    var vm = {};

    var ufdsOptions = {
        url: ufdsUrl,
        bindDN: ufdsDn,
        bindPassword: ufdsPassword
    };

    var UFDS = new sdcClients.UFDS(ufdsOptions);

    UFDS.on('ready', updateVm);
    UFDS.on('error', function (err) {
        return cb(err);
    });

    // - image_uuid, image_os, image_name don't change on resize
    // - ram, quota and billing_id (package uuid) are the ones that could change
    function updateVm() {
        if (job.params.ram) {
            vm.ram = job.params.ram;
        }

        if (job.params.quota) {
            vm.quota = job.params.quota;
        }

        if (job.params['billing_id']) {
            vm['billing_id'] = job.params['billing_id'];
        }

        var operation = {
            type: 'replace',
            modification: vm
        };

        return UFDS.modify(dn, operation, onUpdateVm);
    }

    function onUpdateVm(err) {
        if (err) {
            return cb(err);
        }

        return cb(null, 'Customer VM updated on UFDS');
    }
}




var workflow = module.exports = {
    name: 'update-' + VERSION,
    version: VERSION,
    chain: [ {
        name: 'common.validate_params',
        timeout: 10,
        retry: 1,
        body: common.validateForZoneAction
    }, {
        name: 'ufds.update_customer_vm',
        timeout: 10,
        retry: 3,
        body: updateCustomerVm
    }, {
        name: 'common.setup_request',
        timeout: 10,
        retry: 1,
        body: setupRequest
    }, {
        name: 'cnapi.update_vm',
        timeout: 10,
        retry: 1,
        body: common.zoneAction
    }, {
        name: 'cnapi.poll_task',
        timeout: 120,
        retry: 1,
        body: common.pollTask
    }, {
        name: 'vmapi.check_updated',
        timeout: 90,
        retry: 1,
        body: common.checkUpdated
    }],
    timeout: 300,
    onerror: [ {
        name: 'On error',
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }]
};
