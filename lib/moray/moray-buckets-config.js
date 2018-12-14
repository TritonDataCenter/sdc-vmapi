/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * For any Moray bucket in the bucket configurations below, the "data_version"
 * field is used by data migrations to determine what records need to be
 * migrated. A data migration module with a target migration version of N will
 * fetch all records with a "data_version" number of N - 1, modify them (migrate
 * them), and write them with a new "data_version" value of N.
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
            docker: { type: 'boolean' },
            /*
             * This indexed field is used to store the value of the
             * "internal_metadata" field so that it is searchable.
             */
            internal_metadata_search_array: { type: '[string]' },
            data_version: { type: 'number' }
        },
        options: {
            version: 2
        }
    }
};

var SERVER_VMS_BUCKET_CONFIG = {
    name: 'vmapi_server_vms',
    schema: {
        index: {
            data_version: { type: 'number' }
        },
        options: {
            version: 2
        }
    }
};

var VM_ROLE_TAGS_BUCKET_CONFIG = {
    name: 'vmapi_vm_role_tags',
    schema: {
        index: {
            role_tags: { type: '[string]' },
            data_version: { type: 'number' }
        },
        options: {
            version: 2
        }
    }
};

var VM_MIGRATIONS_BUCKET_CONFIG = {
    name: 'vmapi_vm_migrations',
    schema: {
        index: {
            id:  { type: 'string', unique: true },
            created_timestamp: { type: 'string' },
            vm_uuid: { type: 'string' },
            owner_uuid: { type: 'string' },
            source_server_uuid: { type: 'string' },
            target_server_uuid: { type: 'string' },
            state: { type: 'string' },
            data_version: { type: 'number' }
        },
        options: {
            version: 2
        }
    }
};

module.exports = {
    vms: VMS_BUCKET_CONFIG,
    server_vms: SERVER_VMS_BUCKET_CONFIG,
    vm_role_tags: VM_ROLE_TAGS_BUCKET_CONFIG,
    vm_migrations: VM_MIGRATIONS_BUCKET_CONFIG
};
