/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
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

var SERVER_VMS_BUCKET_CONFIG = {
    name: 'vmapi_server_vms',
    schema: {
        options: {
            version: 1
        }
    }
};

var VM_ROLE_TAGS_BUCKET_CONFIG = {
    name: 'vmapi_vm_role_tags',
    schema: {
        index: {
            role_tags: { type: '[string]' }
        },
        options: {
            version: 1
        }
    }
};

module.exports = {
    VMS: VMS_BUCKET_CONFIG,
    SERVER_VMS: SERVER_VMS_BUCKET_CONFIG,
    VM_ROLE_TAGS: VM_ROLE_TAGS_BUCKET_CONFIG
};
