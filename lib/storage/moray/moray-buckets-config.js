/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var VMS_BUCKET_CONFIG = {
    name: 'vmapi_vms',
    schema: {
        index: {
            uuid: { type: 'string', unique: true},
            owner_uuid: { type: 'string' },
            image_uuid: { type: 'string' },
            billing_id: { type: 'string' },
            server_uuid: { type: 'string' },
            package_name: { type: 'string' },
            package_version: { type: 'string' },
            tags: { type: 'string' },
            brand: { type: 'string' },
            state: { type: 'string' },
            alias: { type: 'string' },
            max_physical_memory: { type: 'number' },
            create_timestamp: { type: 'number' },
            docker: { type: 'boolean' }
        },
        options: {
            version: 1
        }
    }
};

var SERVER_VMS_MORAY_BUCKET_CONFIG = {
    name: 'vmapi_server_vms',
    schema: {}
};

var ROLE_TAGS_MORAY_BUCKET_CONFIG = {
    name: 'vmapi_vm_role_tags',
    schema: {
        index: {
            role_tags: { type: '[string]' }
        }
    }
};

module.exports = {
    vms: VMS_BUCKET_CONFIG,
    server_vms: SERVER_VMS_MORAY_BUCKET_CONFIG,
    vm_role_tags: ROLE_TAGS_MORAY_BUCKET_CONFIG
};
