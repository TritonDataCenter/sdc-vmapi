---
title: VMs API (VMAPI)
apisections: Ping, VMs, VM Snapshots, VM Metadata, Jobs, Changelog
markdown2extras: tables, code-friendly
---
<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2017, Joyent, Inc.
-->

# Introduction to VMs API

## What is VMAPI?

VMAPI is an HTTP API server for managing VMs on an SDC installation.

# Features

* Search for VMs by specific criteria such as ram, owner, tags, etc.
* Get information about a single VM
* Create VMs
* Perform actions on an existing VM such as start, stop, reboot, update, modify NICs, destroy, etc.

# VM Object

The following is the list of attributes that can be associated with a VM. By
default the API returns a fixed list of fields, so there are additional fields
that will also be returned if they are set, otherwise they are considered to have
null values. Some of these fields can be set by both a CreateVm or UpdateVm
call, while some of them can only be set at VM creation time. In the next table,
the column "VM Response Default" refers to attributes that are always going to
be part of the VM response object. Those with a column value of 'No' are only
going to be returned when set via CreateVm or UpdateVm. Finally, the last two
columns specify wether or not some VM attributes can be set at creation or
update time.

| Param                    | Type                          | Description                                                                                                                                                                                                               | Vm Response Default | Create | Update |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------ | ------ |
| alias                    | String                        | VM alias (max length 189 chars, and must match `/^[a-zA-Z0-9][a-zA-Z0-9\_\.\-]*$/`)                                                                                                                                       | Yes                 | Yes    | Yes    |
| autoboot                 | Boolean                       | Controls whether or not a VM is booted when the system is rebooted.                                                                                                                                                       | Yes                 | Yes    | Yes    |
| billing_id               | UUID                          | UUID of the PAPI package associated with this VM                                                                                                                                                                          | Yes                 | Yes    | Yes    |
| brand                    | String                        | Brand of the VM (joyent, joyent-minimal, kvm or sngl)                                                                                                                                                                     | Yes                 | Yes    | No     |
| cpu_cap                  | Number                        | CPU Cap                                                                                                                                                                                                                   | No                  | Yes    | Yes    |
| cpu_shares               | Number                        | CPU Shares                                                                                                                                                                                                                | Yes                 | Yes    | Yes    |
| create_timestamp         | Date                          | The time at which the VM was created in ISO 8601 format                                                                                                                                                                   | Yes                 | No     | No     |
| customer_metadata        | Object                        | VM metadata                                                                                                                                                                                                               | Yes                 | Yes    | Yes    |
| destroyed                | Date                          | The time at which the VM was destroyed in ISO 8601 format                                                                                                                                                                 | Yes                 | No     | No     |
| datasets                 | Array                         | VM datasets                                                                                                                                                                                                               | Yes                 | No     | No     |
| delegate_dataset         | Boolean                       | Delegate a data dataset to the VM                                                                                                                                                                                         | No                  | Yes    | No     |
| dns_domain               | String                        | Domain value for /etc/hosts and /etc/resolv.conf (max length 255 chars)                                                                                                                                                   | No                  | Yes    | No     |
| do_not_inventory         | Boolean                       | The primary use-case of this attribute is for test VMs that are created but you don't want their existence propagated up to VMAPI since they'll be short-lived and its lifecycle will be physically managed in the server | No                  | Yes    | Yes    |
| firewall_enabled         | Boolean                       | Enable firewall for the VM                                                                                                                                                                                                | Yes                 | Yes    | Yes    |
| fs_allowed               | String (comma-separated list) | Filesystems allowed for the VM                                                                                                                                                                                            | No                  | Yes    | Yes    |
| hostname                 | String                        | Hostname (excluding DNS suffix) for the VM (max length 63 chars, must be DNS-safe)                                                                                                                                        | No                  | Yes    | No     |
| image_uuid               | UUID                          | Image of the VM                                                                                                                                                                                                           | Yes                 | Yes    | No     |
| indestructible_delegated | Boolean                       | When set this property adds an @indestructible snapshot to the delegated data dataset and sets a zfs hold on that snapshot. This hold must be removed before the VM can be deleted enabling a two-step deletion           | No                  | Yes    | Yes    |
| indestructible_zoneroot  | Boolean                       | When set this property adds an @indestructible snapshot to the zoneroot dataset and sets a zfs hold on that snapshot. This hold must be removed before the VM can be deleted or reprovisioned                             | No                  | Yes    | Yes    |
| internal_metadata        | Object                        | Internal VM metadata                                                                                                                                                                                                      | Yes                 | Yes    | Yes    |
| limit_priv               | String (comma-separated list) | Privileges available to the VM                                                                                                                                                                                            | Yes                 | Yes    | Yes    |
| last_modified            | Date                          | The time at which the VM was last modified in ISO 8601 format                                                                                                                                                             | Yes                 | No     | No     |
| maintain_resolvers       | Boolean                       | This boolean indicates that /etc/resolv.conf must be updated when the VM resolvers are updated                                                                                                                            | No                  | Yes    | Yes    |
| max_locked_memory        | Number (MiB)                  | Amounf of memory that can be locked for the VM                                                                                                                                                                            | Yes                 | Yes    | Yes    |
| max_lwps                 | Number                        | Max. Lightweight Processes                                                                                                                                                                                                | Yes                 | Yes    | Yes    |
| max_physical_memory      | Number (MiB)                  | Amount of memory of the VM. For KVM VMs this value should be ram + 1024                                                                                                                                                   | Yes                 | Yes    | Yes    |
| max_swap                 | Number (MiB)                  | Maximum amount of virtual memory. Defaults to 2 x max_phsical_memory and cannot be lower than 256                                                                                                                         | Yes                 | Yes    | Yes    |
| mdata_exec_timeout       | Number                        | Timeout in seconds on the start method of the svc:/smartdc/mdata:execute service running in the VM                                                                                                                        | No                  | Yes    | No     |
| networks                 | Array                         | At provision time, specify the networks on which the VM NICs should be provisioned                                                                                                                                        | No                  | Yes    | No     |
| networks.*.uuid          | String                        | Network UUID. Optional, required if networks.*.name is not present                                                                                                                                                        | --                  | --     | --     |
| networks.*.name          | String                        | Network name. Optional, required if networks.*.uuid is not present                                                                                                                                                        | --                  | --     | --     |
| networks.*.primary       | String                        | Specifies that this will be the primary NIC of the VM. Optional                                                                                                                                                           | --                  | --     | --     |
| networks.*.ip            | IP Address                    | Specifies the IP address desired on this network. Optional                                                                                                                                                                | --                  | --     | --     |
| nics                     | Array                         | VM NICs. They can only be updated. NICs get provisioned for a VM from the values of `networks` in CreateVm. See UpdateNIcs for more details.                                                                              | Yes                 | No     | No     |
| owner_uuid               | UUID                          | VM Owner                                                                                                                                                                                                                  | Yes                 | Yes    | Yes    |
| package_name             | String                        | DEPRECATED: use billing_id                                                                                                                                                                                                | No                  | Yes    | Yes    |
| package_version          | String                        | DEPRECATED: use billing_id                                                                                                                                                                                                | No                  | Yes    | Yes    |
| platform_buildstamp      | String                        | Timestamp of the SDC platform the VM is running on. This value only changes when the platform of the Compute Node where the VM is running is upgraded                                                                     | Yes                 | No     | No     |
| quota                    | Number (GiB)                  | VM quota                                                                                                                                                                                                                  | Yes                 | Yes    | Yes    |
| ram                      | Number (MiB)                  | Amount of memory of the VM                                                                                                                                                                                                | Yes                 | Yes    | Yes    |
| resolvers                | Array                         | DNS resolvers for the VM                                                                                                                                                                                                  | Yes                 | Yes    | Yes    |
| server_uuid              | UUID                          | Server UUID of the VM                                                                                                                                                                                                     | Yes                 | Yes    | No     |
| snapshots                | Array                         | VM snapshots                                                                                                                                                                                                              | Yes                 | No     | No     |
| state                    | String                        | State of the VM                                                                                                                                                                                                           | Yes                 | No     | No     |
| tags                     | Object                        | VM tags                                                                                                                                                                                                                   | Yes                 | Yes    | Yes    |
| tmpfs                    | Number                        | Amount of memory for the /tmp filesystem                                                                                                                                                                                  | No                  | Yes    | Yes    |
| zfs_data_compression     | String                        | Specifies a compression algorithm used for the VM's data dataset                                                                                                                                                          | No                  | Yes    | Yes    |
| zfs_io_priority          | Number                        | ZFS IO Priority                                                                                                                                                                                                           | Yes                 | Yes    | Yes    |
| zlog_max_size            | Number                        | Sets the maximum size of the stdio.log file for a docker zone before rotation. NOTE: To be used by sdc-docker only.                                                                                                       | No                  | Yes    | Yes    |

Furthermore, when dealing with KVM VMs there are additional attributes to know
about and are specific to KVM being a different type of virtualization: cpu_type,
disks, disk_driver, nic_driver and vcpus. KVM VMs require at least
two disks and only the properties documented below should be specified. For
additional advanced attributes that can be set on disks please refer to the
vmadm(1) man page.

| Param               | Type         | Description                              | Vm Response Default | Create | Update |
| ------------------- | ------------ | ---------------------------------------- | ------------------- | ------ | ------ |
| cpu_type            | String       | Type of virtual CPU exposed to the guest | Yes                 | Yes    | No     |
| disk_driver         | String       | Drivel model for the VM disks            | Yes                 | Yes    | No     |
| disks               | Array        | Disks for the KVM VM.                    | Yes                 | Yes    | No     |
| disks[0].image_uuid | UUID         | Image UUID for the KVM VM                | Yes                 | Yes    | No     |
| disks[1].size       | Number (MiB) | Size of the disk                         | Yes                 | Yes    | No     |
| nic_driver          | String       | Drivel model for the VM NICs             | Yes                 | Yes    | No     |
| vcpus               | Number       | Number of virtual CPUs                   | Yes                 | Yes    | No     |

The following is a sample VM response object. The only two endpoints that return
VM objects are GetVm and ListVms. ListVms returns a collection of VM objects.

    {
      "uuid": "ef375f03-57ca-44a9-bc8d-63aec09fbc37",
      "brand": "joyent",
      "dataset_uuid": "01b2c898-945f-11e1-a523-af1afbe22822",
      "image_uuid": "01b2c898-945f-11e1-a523-af1afbe22822",
      "server_uuid": "564d6836-ed2e-18f8-bdf2-e900490a57a1",
      "alias": "assets1",
      "ram": 64,
      "max_physical_memory": 64,
      "max_swap": 256,
      "quota": 10240,
      "cpu_cap": 100,
      "cpu_shares": 1,
      "max_lwps": 1000,
      "create_timestamp": "2012-05-16T23:33:09.809Z",
      "destroyed": "",
      "last_modified": "2012-05-16T23:33:12.000Z",
      "zone_state": "running",
      "state": "running",
      "zpool": "zones",
      "zfs_io_priority": 10,
      "owner_uuid": "930896af-bf8c-48d4-885c-6573a94b1853",
      "nics": [
        {
          "interface": "net0",
          "mac": "90:b8:d0:d6:26:6e",
          "vlan_id": 0,
          "nic_tag": "admin",
          "ip": "10.99.99.192",
          "netmask": "255.255.255.0",
          "gateway": "10.99.99.7",
          "primary": true
        }
      ],
      "resolvers": [
        "10.99.99.11"
      ],
      "customer_metadata": {
        "host-ip": "10.99.99.9"
      },
      "internal_metadata": {
          "throttle": true
      },
      "tags": {
        "smartdc_role": "assets",
        "smartdc_type": "core"
      },
      "snapshots": [
        {
          "name": "zones/ef375f03-57ca-44a9-bc8d-63aec09fbc37@backup"
        }
      ],
    }

The following is a sample KVM VM response object (brand == kvm). Note the additional
attributes present in the payload:

    {
      "uuid": "03750e6a-fcf6-4755-85b5-22b8ddf0f1fb",
      "brand": "kvm",
      "image_uuid": "56108678-1183-11e1-83c3-ff3185a5b47f",
      "server_uuid": "564d47c4-b845-113b-664f-2a1d85d0020c",
      "billing_id": "00000000-0000-0000-0000-000000000000",
      "alias": null,
      "ram": 256,
      "max_physical_memory": 512,
      "max_swap": 512,
      "quota": null,
      "cpu_cap": null,
      "cpu_shares": 2,
      "max_lwps": 2000,
      "create_timestamp": "2012-12-21T06:55:27.654Z",
      "destroyed": null,
      "last_modified": "2012-12-21T06:55:32.000Z",
      "zone_state": "running",
      "state": "running",
      "zpool": null,
      "zfs_io_priority": 100,
      "owner_uuid": "00000000-0000-0000-0000-000000000000",
      "nics": [
        {
          "interface": "net0",
          "mac": "90:b8:d0:88:45:a8",
          "vlan_id": 0,
          "nic_tag": "admin",
          "gateway": "10.99.99.7",
          "primary": true,
          "ip": "10.99.99.32",
          "netmask": "255.255.255.0",
          "model": "virtio"
        }
      ],
      "resolvers": [
        "10.99.99.11"
      ],
      "snapshots": [],
      "customer_metadata": {},
      "internal_metadata": {},
      "tags": {},
      "vcpus": 1,
      "cpu_type": "host",
      "disks": [
        {
          "path": "/dev/zvol/rdsk/zones/03750e6a-fcf6-4755-85b5-22b8ddf0f1fb-disk0",
          "boot": false,
          "model": "virtio",
          "media": "disk",
          "image_size": 10240,
          "image_uuid": "56108678-1183-11e1-83c3-ff3185a5b47f",
          "image_name": "ubuntu10.04",
          "zfs_filesystem": "zones/03750e6a-fcf6-4755-85b5-22b8ddf0f1fb-disk0",
          "zpool": "zones",
          "size": 5120,
          "compression": "off",
          "block_size": 8192
        },
        {
          "path": "/dev/zvol/rdsk/zones/03750e6a-fcf6-4755-85b5-22b8ddf0f1fb-disk1",
          "boot": false,
          "model": "virtio",
          "media": "disk",
          "size": 10240,
          "zfs_filesystem": "zones/03750e6a-fcf6-4755-85b5-22b8ddf0f1fb-disk1",
          "zpool": "zones",
          "compression": "off",
          "block_size": 8192
        }
      ]
    }

# VM States

The VM response object contains a state attribute that should be used as the
high level representation of the machine state. There are three 'running state'
values for a VM, two 'provisioning state' values and an additional 'active'
state that is only available as a search filter when used in the ListVms API
endpoint:

| VM State     | Description |
| ------------ | ----------- |
| running      | Self-explanatory |
| stopped      | Self-explanatory |
| destroyed    | Self-explanatory |
| provisioning | VM is currently being provisioned in the system |
| incomplete   | |
| failed       | VM provisioning has failed |
| active       | When used in ListVms, denotes machines that are not 'destroyed' or 'failed' |

<!-- TODO: validate this is the complete set. What is the translation from
zone_state? -->


In addition, there is a 'zone_state' property that represents the Solaris Zones state, since every VM is really a zone internally. The state property should be used in favor of zone_state at all times, but zone_state is provided in case it's needed for debugging purposes. The following is a table that shows all the possible zone_state values:

| Zone State    |
| ------------- |
| configured    |
| incomplete    |
| installed     |
| ready         |
| running       |
| shutting down |


# VM Features

Some VM attributes can be updated (or set at VM creation time) in order to make
use of features that are supported on SDC. Currently, the following three
features can be activated for VMs: delegate dataset, firewall and indestructible
zoneroot/dataset.

## VM Resize

When properties that represent physical attributes (RAM, swap, quota, I/O
priority, etc) of a VM are changed, the VM is considered to have been resized.
Since resizing a VM might cause unwanted effects depending on the current
resources being utilized on the machine, this feature is only partially
supported at the moment. For more information about how to resize a VM please
refer to the [UpdateVm](#UpdateVm) section of this document. The following table
describes the current resize support for KVM and OS VMs. Upsizing means when
some VM attributes are increased and downsizing refers to the opposite.

| VM Type | Upsize        | Downsize      |
| ------- | ------------- | ------------- |
| KVM     | Not supported | Not supported |
| OS      | Supported     | Supported     |

## Delegate Dataset

If the `delegate_dataset` property is set when creating a non-KVM VM, the
machine will get a ZFS dataset mounted at (zoneroot dataset)/data (or just /data
when inside the VM). This property will only have an effect when passed as a
boolean with a value of true. The following is an example CreateVm call for
a VM with a delegate dataset:

    POST /vms -d '{
      "owner_uuid": "930896af-bf8c-48d4-885c-6573a94b1853",
      "image_uuid": "28445220-6eac-11e1-9ce8-5f14ed22e782",
      "brand": "joyent",
      "networks": ["a4457fc9-c415-4ac9-8738-a03b1a8e7aee"],
      "billing_id":"0ea54d9d-8d4d-4959-a87e-bf47c0f61a47",
      "delegate_dataset": true
    }'

## Firewall

If the `firewall_enabled` property is set when creating or updating a VM,
firewall rules will be applied according to FWAPI and `fwadm`. For more
information about how to specify firewall rules for VMs, please refer to the
FWAPI documentation. The following is an example UpdateVm call for activating
firewall on a VM:

    POST /vms/e9bd0ed1-7de3-4c66-a649-d675dbce6e83?action=update -d '{
        "firewall_enabled": true
    }'

## Indestructible Zoneroot and Delegated

Both properties have the effect of adding an @indestructible snapshot to either
the zoneroot (the VM itself) or the delegate dataset in order to prevent them
from being deleted. Having an indestructible delegate dataset is useful when
reprovisioning a VM, since it's data dataset will be preserved but the VM itself
is going to be recreated. The following is an example UpdateVm call for setting
indestructible on the zoneroot:

    POST /vms/e9bd0ed1-7de3-4c66-a649-d675dbce6e83?action=update -d '{
        "indestructible_zoneroot": true
    }'


# VM Job Response Object

Any action called on the VMs or Metadata endpoints will result on a new Job being created on the backend. Performing an action on VM doens't imply that changes are going to be reflected immediately, so a Job response object will provide the user with the necessary info to get more details about progress of the task that has been queued. The user can poll the GET /jobs/<uuid> endpoint for more details and also GET /vms/<uuid> to see if the VM properties have changed after the job completes.

    {
      "vm_uuid": "ef375f03-57ca-44a9-bc8d-63aec09fbc37",
      "job_uuid": "6ad3a288-31cf-44e0-8d18-9b3f2a031067"
    }


# Error Response Object

Error responses will be returned when the response status code is one of 40X errors including 404. These responses will have an error code and a message:

    {
      "code": "ResourceNotFound",
      "message": "Route does not exist"
    }


# Ping VMAPI

Use ping when you want a general status report from VMAPI. VMAPI makes HTTP
connections to REST APIs and TCP connections to services like moray. The
**ping**  endpoint provides a compact response object that lets clients know
what is VMAPI's point of view of the backend services it is connected to. The
following is the format of the ping response object.

## Ping (GET /ping)

    GET /ping

    {
      "pingErrors": {},
      "pid": 12456,
      "status": "OK",
      "healthy": true,
      "services": {
        "wfapi": "online",
        "moray": "online"
      }
      "initialization": {
          "moray": {
            "status": "BUCKETS_REINDEX_DONE",
            "error": "latest error encountered during moray buckets initialization"
          }
        }
      },
      "dataMigrations": {
        "latestCompletedMigrations": {
          "vms": 1
        },
        "latestErrors": {
          "vms": "Error: error encountered during data migrations"
        }
      }
    }

The **pingErrors** attribute is an object where each of its keys is the name of
an API (wfapi, moray, cnapi or napi) and the value of each key is the error
response that was obtained after pinging the correspondent service.

Of special note is the **status** attribute that lets us know if VMAPI is fully
functional in terms of data and services initialized. A "healthy: true" value
from the ping response means that VMAPI has not had HTTP or backend
initialization errors.

The `initialization.moray.status` property can have the following values:

* `NOT_STARTED`: the moray buckets initialization process hasn't started yet.
* `STARTED`: the moray buckets initialization process has started, but all
  buckets haven't been completely setup (created and updated to the current
  schemas) yet.
* `BUCKETS_SETUP_DONE`: the moray buckets have all been created and/or updated
  to their current schema.
* `BUCKETS_REINDEX_DONE`: the moray buckets have all been created and/or updated
  to their current schema, and all their rows have been reindexed.
* `FAILED`: the moray buckets initialization has failed with a non transient
  error.

The `dataMigrations` property is composed of two sub-properties:

1. `latestCompletedMigrations`: an object that has properties whose names
   identify data models (`vms`, `server_vms`, `vm_role_tags`) and whose values
   indicate the sequence number of the latest migrations that completed
   successfully for that model.

2. `latestErrors`: an object structured similarly to
   `latestCompletedMigrations`, but instead of values identifiying the latest
   migration that completed successfully, they represent the latest error that
   occured when migration the data for the corresponding data model.

# VMs

The Vms endpoint let us get information about VMs living on a SDC install; there is only one VMAPI instance per datacenter. VMAPI acts as an HTTP interface to VM data stored in Moray. VMAPI is used to obtain information about particular VMs, or when we need perform actions on them -- such as start, reboot, resize, etc.

## ListVms (GET /vms)

Returns a list of VMs according the specified search filter.

### Inputs

All inputs are optional. Inputs that are not listed below are invalid, and
will result in a request error.

| Param            | Type                                             | Description                                     |
| ---------------- | ------------------------------------------------ | ----------------------------------------------- |
| alias            | String                                           | VM Alias|
| billing_id       | UUID                                             | UUID of the package the VM was created with     |
| brand            | String                                           | Brand of the VM (joyent, joyent-minimal or kvm) |
| create_timestamp | Unix Time in milliseconds or UTC ISO Date String | VM creation timestamp                           |
| docker           | Boolean                                          | true if the VM is a docker VM, false otherwise  |
| fields           | String (comma-separated values)                  | Specify which VM fields to return, see below    |
| image_uuid       | UUID                                             | Image of the VM                                 |
| internal_metadata| String                                           | VM internal metadata, [see below](#internal-metadata)
| owner_uuid       | UUID                                             | VM Owner                                        |
| package_name     | String                                           | DEPRECATED: use billing_id                      |
| package_version  | String                                           | DEPRECATED: use billing_id                      |
| uuid             | UUID                                             | VM uuid                                         |
| ram              | Number                                           | Amount of memory of the VM                      |
| server_uuid      | UUID                                             | Server where the VM lives                       |
| state            | String                                           | running, stopped, active or destroyed           |
| uuids            | String (comma-separated UUID values)             | List of VM UUIDs to match                       |
| tag.key          | String                                           | VM tags, see below                              |

### Specifying VM Fields to Return

Clients can also modify the response objects by specifying the only fields they
are interested in. This is not only useful for fetching smaller responses but
for accessing attributes that can only be explicitly requested, such as
`role_tags`. The fields query parameter is a comma-separated string of VM
fields, any field that is not part of the VM object will be ignored. This
parameter allows an additional wildcard '*' field, as a shortcut for asking the
API to return all default and non-default fields available. At the moment,
role_tags is the only non-default field supported. The following are some
example requests that use the fields query parameter:

    GET /vms?fields=*
    GET /vms?fields=role_tags
    GET /vms?fields=uuid,role_tags,nics
    GET /vms?fields=state,alias,server_uuid

### Collection Size Control Inputs

ListVms also allows controlling the size of the resulting collection with the
use of the sort, limit, and marker parameters. "sort" and "limit" can be
used on either the regular or the LDAP query version of the ListVms endpoint.

| Param      | Type   | Description                                         |
| ---------- | ------ | --------------------------------------------------- |
| sort       | String | Sort by any of the ListVms inputs (except tags).    |
| sort.order | String | Order direction. See below                          |
| limit      | Number | Return only the given number of VMs                 |
| marker     | String | Limit the collection starting from the given VM represented by "marker". |

#### Limit

**Since version 8.0.0, the default and maximum limit on the size of the
resulting collection is 1000.** In order to paginate through the whole set of
VMs, one should either use the "marker" parameter described above, or use the
joyent/node-sdc-clients module.

#### Sorting

The *sort* direction can be:

* 'asc' or 'ASC' to sort by ascending order
* 'desc' or 'DESC' to sort by descending order

The sort direction is descending by default. The following are some examples
of valid values for the *sort* parameter:

    sort=uuid (results in 'uuid DESC')
    sort=alias.desc (results in 'uuid DESC')
    sort=alias.asc (results in 'uuid ASC')

By default, any response is sorted by `uuid` descending so that it can be
used as the first page of subsequent paginated requests using the `marker`
parameter.

#### Using the "marker" parameter to paginate through results

When listing VMs, the number of VMs returned in the response for one request
is limited to 1000 entries. If there are more VMs to list for a given set of
parameters/filters, more than one request will need to be sent with the same
parameters to paginate through the results. Each request will fetch one page
of results.

When paginating through results, set the "marker" parameter for each page but
the first one. Set the value of "marker" to a string that represents the
latest entry of the previous page.

How to represent the latest entry of the previous page depends on whether the
"sort" parameter is used (more below in the sub-section entitled "Using
markers when using the "sort" parameter").

But for now let's consider the simple use case of not using the "sort"
parameter and describe how to paginate through a list of 4 VMs while using a
limit of 2 entries per response:

  1. Send the `GET /vms?limit=2` request. The "marker" parameter is not used
  because this request gets the first page of results.

  2. The response for this request is for instance: `[{uuid: 1},{uuid: 2}]`

  3. Send the same request, this time adding a "marker" parameter. Its value
  is a JSON string that represents an object with the uuid of the latest entry
  from the latest results: `GET /vms?limit=2&marker={"uuid": 2}`

  4. The response to this request is for instance: `[{uuid: 3},{uuid: 4}]`

  5. Now send the same request as the previous one, but set "marker" to include the
  uuid of the latest entry from the latest results: `GET
  /vms?limit=2&marker={"uuid": 4}`.

  6. The response to this request is an empty array (`[]`) because there's
  only 4 VMs in the data set. We're done paginating through results.

Please note that in reality, uuids are not simple numbers and they are not
necessarily contiguous values.

##### Valid markers

A valid marker is a string that satisfies the following constraints:

1. It is a JSON string that represents a JavaScript object literal. JSON strings
that represent strings, arrays or anything else that is not an object literal
will result in a request error.

2. It represents an object that has at most two properties: `uuid` and any
property on which it is possible to sort the result set if a sort parameter is
used.

##### Using markers when using the "sort" parameter

###### Always include one strict total order field in the marker

Let's consider that we're listing VMs and sorting them by time of creation
descending:

`GET /vms?sort=create_timestamp.DESC`

In this case, it may be tempting to use only the `create_timestamp` value of
the latest VM object as the marker, and send the following request to get the
second page of results:

`GET /vms?sort=create_timestamp.DESC&marker={"create_timestamp": "some_timestamp"}`

The problem with this request is that two or more VMs can have the same value
for the `create_timestamp` property, and thus the server cannot determine
which one(s) to include in the results.

In fact, the server will respond to this request with the following error:

```
{
  "code": "ValidationFailed",
  "message": "Invalid Parameters",
  "errors": [
    {
      "field": "marker",
      "code": "Invalid",
      "message": "Invalid marker: {\"create_timestamp\":\"some_timestamp\"}. A marker needs to have a uuid property from which a strict total order can be established"
    }
  ]
}
```

The solution to this problem is to always include in the marker a property
that allows to establish a strict total order over the results set so that it
can represent a single object without any ambiguity. Currently, as the error
message mentioned above indicates, the only property that provides this
guarantee is `uuid`.

Thus, a correct request to get the second page of results is:

`GET /vms?sort=create_timestamp.DESC&marker={"create_timestamp": "some_timestamp", "uuid": "uuid-of-latest-vm"}`

###### Always include the sort field in the marker

When using both the `sort` and `marker` parameters, make sure the sort field is
included in the marker. For instance, the following request:

`GET /vms?sort=create_timestamp.DESC&maker={"uuid":"some-uuid"}`

will result in the following error message being sent:

```
{
  "code": "ValidationFailed",
  "message": "Invalid Parameters",
  "errors": [
    {
      "field": "marker",
      "code": "Invalid",
      "message": "Invalid marker: {\"uuid\":\"some-uuid\"}. All sort fields must be present in marker. Sort fields: create_timestamp."
    }
  ]
}
```

To solve this problem, just include the `create_timestamp` value for the
latest item in the current result set in the marker:

`GET /vms?sort=create_timestamp.DESC&maker={"create_timestamp":"some-timestamp","uuid":"some-uuid"}`

###### Always include marker fields in the sort parameter, except for the `uuid` field

When using a marker with a field other than `uuid`, make sure to include this
field in the sort parameter. It is not necessary to include the `uuid` field
as a sort parameter when using a marker because responses are already sorted
by uuid by default.

For instance, the following request:

`GET /vms?marker:{"uuid": "someuuid"}`

will not result in an error, but this request:

`GET /vms?marker:{"uuid": "someuuid", "create_timestamp": "some_timestamp"}`

will result in the following error message being sent:

```
{
  "code": "ValidationFailed",
  "message": "Invalid Parameters",
  "errors": [
    {
      "field": "marker",
      "code": "Invalid",
      "message": "Invalid marker: {\"uuid\":\"someuuid\",\"create_timestamp\":\"some_timestamp\"}. All marker keys except uuid must be present in the sort parameter. Sort fields: undefined."
    }
  ]
}
```

To fix this problem, just add a `sort` parameter to the request, like following:

`GET /vms?sort=create_timestamp&marker:{"uuid": "someuuid", "create_timestamp": "some_timestamp"}`

#### Deprecated parameters

ListVms also supports parameter that have been deprecated and should not be
used anymore.

| Deprecated param | Type   | Description                                   |
| ---------------- | ------ | --------------------------------------------- |
| offset           | Number | Limit the collection starting from the given  |
|                  |        | offset                                        |

"offset" and "marker" cannot be used at the same time, and using them both will
result in a request error.

### Tags

VMs can also be searched by tags. Tags are key/value pairs that let us identify a vm by client-specific criteria. If a VM is tagged as 'role=master', then the search filter to be added to the request params should be 'tag.role=master'. When a tag value is '*', the search is performed for VMs that are tagged with any value of the specified key. Any number of tags can be specified. See the examples section for sample searches of VMs by tags.

### Internal metadata

VMs can be searched by internal metadata. Internal metadata is an object with
keys and values that are always strings. There are no nested objects/properties.
Pattern matching is not available, so matching needs to be exact.

For example, to search for VMs with a `docker:logdriver` internal metadata key
with a value of `"json-file"`, one can send the following query:

```
GET /vms?internal_metadata.docker:logdriver=json-file
```

There is one limitation to keep in mind: matching a string in a given internal
metadata key that is larger than 100 characters is not supported.

### ListVms Responses

| Code | Description | Response            |
| ---- | ----------- | ------------------- |
| 200  | Response OK | Array of VM objects |

### ListVms Examples

    GET /vms
    GET /vms?limit=10
    GET /vms?sort=alias.asc&limit=100
    GET /vms?alias=my-vm
    GET /vms?state=running
    GET /vms?tag.role=sdc
    GET /vms?tag.role=sdc&tag.type=database
    GET /vms?tag.role=*


## ListVms With Search Predicate

Using a predicate is the preferred method for performing advanced searches at
GET /vms. A predicate allows us to easily express a complex query when there are
several fields that need to match specific values. VMAPI uses the same predicate
syntax exposed by Cloud Analtyics (https://mo.joyent.com/docs/ca/master), but
some operations such as "lt" (less than) are not supported since they do not
form a valid LDAP query syntax.

A predicate can be composed of leaf predicates and compound predicates. Leaf
predicates denote a direct comparison, like "field equals value", and compound
predicates have one or more subpredicates that can be either compound or leaf
predicates themselves.

### Leaf Predicates

| Predicate                    | Description                             |
| ---------------------------- | --------------------------------------- |
| { eq: [ fieldname, value ] } | Equality (field=value)                  |
| { ne: [ fieldname, value ] } | Inequality (!(field=value))             |
| { le: [ fieldname, value ] } | Less than or equal to (field<=value)    |
| { ge: [ fieldname, value ] } | Greater than or equal to (field>=value) |

### Compound Predicates

| Predicate                   | Description                                 |
| --------------------------- | ------------------------------------------- |
| { and: [ predicate, ... ] } | All subpredicates must be true.             |
| { or: [ predicate, ... ] }  | At least one of subpredicates must be true. |

### Executing Predicate Queries

A predicate search can be performed by passing a `predicate` query parameter to
the GET /vms endpoint. Keep in mind that the predicate must be URL encoded, as it
contains characters like '[', '{' , '&', etc. that will not be parsed correctly
by the HTTP server, and will result in a request error.

In order to make testing of predicates easy, use the following code snippet that
creates a urlencode helper function that can be called to convert a predicate
object to a URL encoded string:

    urlencode() {
        # urlencode <string>

        local length="${#1}"
        for (( i = 0; i < length; i++ )); do
            local c="${1:i:1}"
            case $c in
                [a-zA-Z0-9.~_-]) printf "$c" ;;
                *) printf '%%%02X' "'$c"
            esac
        done
    }

Let's look at some usage examples of search predicates:

#### Search for VMs with less than or equal to 128MB RAM

    sdc-vmapi "/vms?predicate=$(urlencode '{ "le" : [ "ram", 128 ] }')" \
      | json -Ha uuid ram

    215366ea-1646-4d2b-934d-ba10d7859189 128
    54a70ea7-aa36-473f-a095-c1e1dee99966 128
    1af5138e-8c23-4fdf-f13a-b0c4d275a026 64
    73edd07f-93b9-4463-e132-fcb64b46f3be 64

#### Search for destroyed VMs tagged with role=database

    sdc-vmapi "/vms?predicate=$(urlencode '{ "and" : [ { "eq": ["state", "destroyed" ] }, { "eq": ["tag.role", "database" ] }  ] }')" \
      | json -Ha uuid ram state tags.role

    1af5138e-8c23-4fdf-f13a-b0c4d275a026 64 destroyed database

#### Search all VMs with a wildcard alias of vmapi* that have 1024MB RAM

    sdc-vmapi "/vms?predicate=$(urlencode '{ "and" : [ { "eq" : [ "ram", 1024 ] }, { "eq" : [ "alias", "vmapi*"  ] } ] }')" \
      | json -Ha uuid ram

    2a564d9f-ae52-4ac7-8d98-1ef00a95e086 1024


## ListVms With Search Query

There is also an advanced feature in the VMs endpoint, where you can execute an LDAP-compatible search filter if you want a more precise object search. However, you need to consider that the same rules regarding searchable attributes apply to this endpoint, so any search on an non-indexed column will return an error. All the searchable attributes listed in the Inputs table above for the ListVms endpoint can be used, with the exception of create_timestamp, where only its Unix time form can be passed. Additionally, there is a very special format you need to respect if you want to search VMs by tags. More on this below.

### Executing LDAP Search Queries

In order to execute a search query against the /vms endpoint, you need to pass a string parameter called `query`. The string must have the form of a valid LDAP search filter, or you will get an error. Here are some usage examples of this feature:

    GET /vms?query=(alias=adminui*)
    GET /vms?query=(ram>=1024)
    GET /vms?query=(%26(ram<=256)(alias=adminui*)
    GET /vms?query=(%26(ram=512)(alias=adminui0))

Note how the '&' character is escaped as '%26', since the query must be URL encoded. The only exception in the searchable attributes are tags. Since tags have a special format in the database, they have a different but straightforward format for the search filter. Below is an example of searching VMs with a specific tag by using a logical OR:

    GET /vms?query=(|(tags=*-smartdc_type=core-*)(ram>=1024))

As we can see, all we need to do is to enclose the key=value format of tag by the '\*-'' and '-\*'' characters. These are some examples of how to convert tags into a search expression for VMAPI:

| Tag Key  | Tag Value | Tag String    | Search Expression        |
| -------- | --------- | ------------- | ------------------------ |
| role     | dns       | role=dns      | tags=\*-role=dns-\*      |
| priority | high      | priority=high | tags=\*-priority=high-\* |
| purpose  | db        | purpose=db    | tags=\*-purpose=db-\*    |



## GetVm (GET /vms/:uuid)

Returns a VM with the specified UUID. When sync=true is passed, VMAPI will directly load VM details with a synchronous call to CNAPI. This will also refresh the VMs cache so that if a VM was already destroyed and it doesn't appear to be, it will be marked as such in the process. Using the sync version of this action can be seen as 'force VMAPI' to load the VM information directly from CNAPI.

### Inputs

| Param      | Type    | Description                                                                                                                                                                                      | Required? |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| uuid       | UUID    | VM UUID                                                                                                                                                                                          | Yes       |
| owner_uuid | UUID    | VM Owner. If specified, the VM object will be checked for ownership against this owner_uuid. If vm.owner_uuid does not match the provided value the call will result in a 404 VM Not Found error | No        |
| sync       | Boolean | Load VM info from CNAPI                                                                                                                                                                          | No        |

### Specifying VM Fields to Return

Same as ListVms, clients can modify the response object by specifying the only fields they are interested in. The fields query parameter is a comma-separated
string of VM fields, any field that is not part of the VM object will be
ignored. This parameter allows an additional wildcard '*' field, as a shortcut for asking the API to return all default and non-default fields available. At
the moment, role_tags is the only non-default field supported.

### Responses

| Code | Description                                                                  | Response     |
| ---- | ---------------------------------------------------------------------------- | ------------ |
| 200  | Response OK                                                                  | VM object    |
| 404  | VM Not Found. VM does not exist or VM does not belong to the specified owner | Error object |

### Examples

    GET /vms/00956725-4689-4e2c-9d25-f2172f496f9c
    GET /vms/00956725-4689-4e2c-9d25-f2172f496f9c?fields=uuid,role_tags
    GET /vms/00956725-4689-4e2c-9d25-f2172f496f9c?fields=*
    GET /vms/00956725-4689-4e2c-9d25-f2172f496f9c?sync=true

## CreateVm (POST /vms)

Queues a VM provision. This will validate all parameters and create a new job on workflow API when the request is considered to be valid. The response is
the same as a GET to /vms/:uuid, however some VM attributes might not be present since it has not been provisioned yet. The response also contains a Job-Location header which can be used to get more information about the provisioning job that is being executed by workflow API.

### Minimum Required Inputs

| Param       | Type   | Description                                                                                              |
| ----------- | ------ | -------------------------------------------------------------------------------------------------------- |
| owner_uuid  | UUID   | VM Owner                                                                                                 |
| networks*   | Array* | List of networks. See 'Specifying Networks for a VM' below.                                              |
| brand       | String | 'joyent', 'joyent-minimal' or 'kvm'                                                                      |
| ram*        | Number | VM RAM. Not required if billing_id is present                                                            |
| billing_id* | UUID   | SDC Package UUID. Not required if at least ram is present. See 'Provisioning with an SDC Package' below. |

### Required Inputs for OS VMs

| Param      | Type | Description                                                                                        |
| ---------- | ---- | -------------------------------------------------------------------------------------------------- |
| image_uuid | UUID | Image UUID. **This field is not allowed as a top level attribute for a KVM VM payload, see below** |

### Required Inputs for KVM VMs

| Param | Type  | Description                                |
| ----- | ----- | ------------------------------------------ |
| disks | Array | Disks definition for the KVM VM, see below |

KVM VMs need a list of disks as an additional parameter. For more specific information on the full format that a disk object can take please refer to vmadm(1). In the case of VMAPI, there are only two conditions that need to be met for a valid disks list:

* The first disk MUST have a 'image_uuid' property. This is required because the first disk of the VM is the disk where the OS gets installed. Passing 'image_uuid' at the top level of the VM payload ***is not allowed*** as it will not give the expected results.

When image_uuid is passed incorrectly for KVM VMs, VMAPI will return the following error response:


      {
        "code": "ValidationFailed",
        "message": "Invalid VM parameters",
        "errors": [
          {
            "field": "image_uuid",
            "code": "Invalid",
            "message": "'image_uuid' is not allowed as a top level attribute for a KVM VM"
          }
        ]
      }


* The second and following disks in the list MUST have a 'size' property. This is mandatory for any disk that is not the image disk of the VM

The following is a simple example of a valid disks list passed to VMAPI for a KVM VM provision:

    "disks": [
      {"image_uuid": "56108678-1183-11e1-83c3-ff3185a5b47f"},
      {"size": 10240}
    ]

Additional information that the first disk of the VM needs before the provision is queued is obtained from the Image specified with image_uuid.

### Specifying Networks for a VM

CreateVm expects a list of `networks` for provisioning a new VM. In its legacy interface (to be deprecated), a list network UUIDs can be specified like the following example:

    [
      '72a9cd7d-2a0d-4f45-8fa5-f092a3654ce2',
      '01b2c898-945f-11e1-a523-af1afbe22822
    ]

This format is suboptimal because it does not allow to specify two additional properties available for each of the network interfaces of the VM. By passing a list of network objects and not a list of UUIDs (strings) for the `networks` parameter, it is possible to manually assign an IP address to any of the networks and/or to specify which is the `primary` network interface of the VM.

Instead, the new form of provisioning is what we call 'Interface-centric provisioning'. The idea is that an interface allows to have both an IPv4 and IPv6 network associated with it, and it may have multiple addresses from those networks assigned to it. However, at this time, we only support a single IPv4 network and IP address. The format of this looks like:

    [
      { "ipv4_uuid": "72a9cd7d-2a0d-4f45-8fa5-f092a3654ce2", "ipv4_count": 1 },
      { "ipv4_uuid": "01b2c898-945f-11e1-a523-af1afbe22822", "ipv4_ips": [ "10.99.99.11" ] },
      ...
    ]

Each object refers to a NIC that will be created. The ipv4_uuid indicates that it is the UUID of an IPv4 network. From there, you can specify the number of IPs you'd like on the network and provide a list of specific IPs that you would like from the network. In the future, these will be able to be combined, but at this time you can only ask for a single IP address, whether specified or passed in with count. If neither of them is specified, or an older format is used, it is treated as though 'ipv4_count' was set to one in the payload.

An older version of the API looked like:

    [
      { "uuid": "72a9cd7d-2a0d-4f45-8fa5-f092a3654ce2", ip: "10.99.99.11" },
      ...
    ]

These are accepted and translated where 'uuid' becomes 'ipv4_uuid', and 'ip' becomes the 'ipv4_ips' array with a single entry. Note other keys that were specified, described below, are not modified. See the Future Directions section below for what will be coming for the future.

The following are examples of what you can do:

* Regular provision with no customization for networks

*Network objects only have an `ipv4_uuid` property:*

    [
      { ipv4_uuid: '72a9cd7d-2a0d-4f45-8fa5-f092a3654ce2' },
      { ipv4_uuid: '01b2c898-945f-11e1-a523-af1afbe22822' }
    ]

* Specifying a custom IP address for any of the networks

*Network objects can have an `ipv4_ips` property. Be advised that manual IP addresses must not be specified without having knowledge of the IP in question
being available for allocation. If the IP is not available for allocation, the provision will fail:*

    [
      { ipv4_uuid: '72a9cd7d-2a0d-4f45-8fa5-f092a3654ce2', ipv4_ips: [ '10.99.99.11' ] },
      { ipv4_uuid: '01b2c898-945f-11e1-a523-af1afbe22822 }
    ]

* Specifying the primary network for a VM

*Network objects can **only** have one `primary` network interface (NIC). When not specified, the first network in the `networks` list becomes the primary NIC for the VM. A VM will set its default gateway and nameservers to the values obtained from its primary NIC. In the following example we make the second NIC of the VM its primary NIC:*

    [
      { ipv4_uuid: '72a9cd7d-2a0d-4f45-8fa5-f092a3654ce2' },
      { ipv4_uuid: '01b2c898-945f-11e1-a523-af1afbe22822', 'primary': true }
    ]

* Specifying network names instead of network UUIDs

*It is also possible to use a network's name instead of its UUID when passing the list of `networks` for the VM. The following example illustrates how to specify a payload of admin and external with external as a primary NIC:*

    [
      { name: 'admin' },
      { name: 'external', primary: true }
    ]

It should be noted that the order of the network objects in the `networks` parameter is significant. The resolvers of a VM will be configured in the same order as the `networks` were specified in the provision payload. Note, at this time, this form will not be adopted for future revisions and will be limited to only allowing a single IPv4 address.

* Specifying antispoof options for a nic

*Network objects can contain boolean antispoof options that enable various types of spoofing. See the NAPI documentation for more details. In the following example we set all antispoof options for the NIC:*

    [
      {
        ipv4_uuid: '72a9cd7d-2a0d-4f45-8fa5-f092a3654ce2',
        allow_dhcp_spoofing: true,
        allow_ip_spoofing: true,
        allow_mac_spoofing: true,
        allow_restricted_traffic: true
      }
    ]

#### Future directions

When support for IPv6 and assigning a single VM multiple IPs from the same network, the payload that we have today will be expanded. In this case it will look something like:

    [
      {
        "ipv4_uuid": "72a9cd7d-2a0d-4f45-8fa5-f092a3654ce2",
        "ipv4_count": 4,
        "ipv4_ips": [ "10.99.99.11", "10.99.99.12" ],
        "ipv6_uuid": "22786760-9e96-11e4-8ba2-5bab126f5cf6",
        "ipv6_count": 2,
      },
      ...
    ]

This allows a consumer to say, for each NIC, they want the specified IPv4 network. They want us to provision four arbitrary IPs and they want an additional two IPs which are specified. They'll want the specified IPv6 netowrk and two IPs from that.

### Provisioning with an SDC Package

VMs can optionally be provisioned by only providing a 'billing_id' SDC Package identifier. When providing an SDC Package, the following VM attributes can be omitted since they will be inherited from the Package definition:

| Param               | Type         |
| ------------------- | ------------ |
| cpu_cap             | Number       |
| max_lwps            | Number       |
| max_physical_memory | Number (MiB) |
| max_swap            | Number (MiB) |
| quota               | Number (GiB) |
| zfs_io_priority     | Number       |
| vcpus               | Number       |

However, these values can still be individualy overriden by providing new values for them in the VM provisionm payload. Note that for the purpose of having a 1:1 VM - SDC Package correspondence it is advised that individual values should not be overriden when it is needed to refer a VM back to its original SDC Package.

### General Optional Inputs

These inputs can be passed and will be validated wether or not a 'billing_id' SDC Package parameter has been provided.

| Param               | Type         | Description                                 |
| ------------------- | ------------ | ------------------------------------------- |
| uuid                | UUID         | The UUID of the VM to be created            |
| server_uuid         | UUID         | Manually specify a server for the provision |
| alias               | String       | VM alias                                    |
| max_physical_memory | Number (MiB) | Same as RAM                                 |
| max_swap            | Number (MiB) | Defaults to 2 x RAM if not specified        |
| zfs_io_priority     | Number       | ZFS IO Priority                             |
| cpu_cap             | Number       | CPU Cap                                     |
| max_lwps            | Number       | Max. Lightweight Processes                  |
| quota               | Number (GiB) | VM quota                                    |
| tags                | Object       | VM tags                                     |
| customer_metadata   | Object       | VM metadata                                 |
| internal_metadata   | Object       | VM metadata                                 |
| limit_priv          | String       | List of priviledges to the VM               |
| locality            | Object       | Locates new VM near or far from certain VMs |

### Advanced Inputs

The attributes listed above cover the most common VM creation scenarios. There
are additional advanced properties that can be set for a VM. The full set of
attributes that can be specified on VM creation or update are listed in the `VM Object`
section in this documentation.

### Optional Inputs for OS VMs

| Param       | Type  | Description                          |
| ----------- | ----- | ------------------------------------ |
| filesystems | Array | Additional filesystems for the OS VM |

### Optional Inputs for KVM VMs

| Param       | Type   | Description                          |
| ----------- | ------ | ------------------------------------ |
| cpu_type    | String | One of qemu64, host                  |
| vcpus       | Number | Number of virtual CPUs for the guest |
| disk_driver | String | One of virtio, ide, scsi             |
| nic_driver  | String | One of virtio, e1000, rtl8139        |


### Response Codes

| Code | Description       | Response           |
| ---- | ----------------- | ------------------ |
| 202  | New job created   | VM response object |
| 409  | Missing parameter | Error object       |
| 409  | Invalid parameter | Error object       |

### Example: creating an OS VM

    POST /vms -d '{
      "owner_uuid": "930896af-bf8c-48d4-885c-6573a94b1853",
      "image_uuid": "28445220-6eac-11e1-9ce8-5f14ed22e782",
      "brand": "joyent",
      "networks": ["a4457fc9-c415-4ac9-8738-a03b1a8e7aee"],
      "ram": 128,
      "quota": 10
    }'

### Example: creating an OS VM by specifying an SDC Package

    POST /vms -d '{
      "owner_uuid": "930896af-bf8c-48d4-885c-6573a94b1853",
      "image_uuid": "28445220-6eac-11e1-9ce8-5f14ed22e782",
      "brand": "joyent",
      "networks": ["a4457fc9-c415-4ac9-8738-a03b1a8e7aee"],
      "billing_id":"0ea54d9d-8d4d-4959-a87e-bf47c0f61a47"
    }'

### Example: creating a KVM VM

Note how image_uuid is specified for the first disk and not at the top level of the payload

    POST /vms -d '{
      "owner_uuid": "930896af-bf8c-48d4-885c-6573a94b1853",
      "brand": "kvm",
      "ram": 256,
      "networks": ["a4457fc9-c415-4ac9-8738-a03b1a8e7aee"],
      "disks": [
        {"image_uuid": "56108678-1183-11e1-83c3-ff3185a5b47f"},
        {"size": 10240}
      ]
    }'

### Example: creating a VM with locality hints

Note that the VM uuids specified have to be owned by the same account as the new VM
To make locality a hard requirement, set the value of "strict" to true

    POST /vms -d '{
      "owner_uuid": "930896af-bf8c-48d4-885c-6573a94b1853",
      "image_uuid": "28445220-6eac-11e1-9ce8-5f14ed22e782",
      "brand": "joyent",
      "networks": ["a4457fc9-c415-4ac9-8738-a03b1a8e7aee"],
      "ram": 128,
      "quota": 10,
      "locality": {
        "strict": false,
        "near": [
          "48bb34cc-5f0f-4cf8-834d-06862a6e89b1",
          "f7951441-5344-4114-88ce-a064820ed9fe"
        ],
        "far": [
          "fb82f801-b90e-475d-951b-028f48ca12c7"
        ]
      }
    }'


## Updating or Modifying a VM (POST /vms/:uuid)

This endpoint queues an update operation on a VM. The folowing operations are
supported: **start, stop, reboot, reprovision, update, add_nics, remove_nics,
create_snapshot, delete_snapshot and rollback_snapshot**. Each of these
operations is documented below.

### General Inputs

| Param      | Type    | Description                                                                                                                                                                                      | Required? |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| uuid       | UUID    | VM UUID                                                                                                                                                                                          | Yes       |
| owner_uuid | UUID    | VM Owner. If specified, the VM object will be checked for ownership against this owner_uuid. If vm.owner_uuid does not match the provided value the call will result in a 404 VM Not Found error | No        |
| action     | String  | start, stop, reboot, reprovision, update, add_nics, remove_nics, create_snapshot, delete_snapshot, rollback_snapshot                                                                             | Yes       |
| sync       | Boolean | Wait for workflow to complete before returning                                                                                                                                                   | No        |

### Response Codes

| Code | Description                                                                  | Response           |
| ---- | ---------------------------------------------------------------------------- | ------------------ |
| 202  | New job created                                                              | VM response object |
| 404  | VM Not Found. VM does not exist or VM does not belong to the specified owner | Error object       |
| 409  | Missing parameter                                                            | Error object       |
| 409  | Invalid parameter                                                            | Error object       |

## StartVm (POST /vms/:uuid?action=start)

See [General Inputs](#general-inputs)

Also allows:

| Param      | Type   | Description                                                                                            |
| ---------- | ------ | ------------------------------------------------------------------------------------------------------ |
| update     | Object | Optional data to update the vm with before it's started. Currently limited to 'set_internal_metadata'. |

### Example

    POST /vms/e9bd0ed1-7de3-4c66-a649-d675dbce6e83?action=start

## StopVm (POST /vms/:uuid?action=stop)

No additional inputs are needed for this action.

### Example

    POST /vms/e9bd0ed1-7de3-4c66-a649-d675dbce6e83?action=stop

## RebootVm (POST /vms/:uuid?action=reboot)

See [General Inputs](#general-inputs)

Also allows:

| Param      | Type   | Description                                                                                            |
| ---------- | ------ | ------------------------------------------------------------------------------------------------------ |
| update     | Object | Optional data to update the vm with before it's started. Currently limited to 'set_internal_metadata'. |

### Example

    POST /vms/e9bd0ed1-7de3-4c66-a649-d675dbce6e83?action=reboot

## ReprovisionVm (POST /vms/:uuid?action=reprovision)

Image UUID is a required input for reprovisioning a VM.

| Param      | Type | Description                           |
| ---------- | ---- | ------------------------------------- |
| image_uuid | UUID | Image UUID to reprovision the VM with |

### Example with a JSON payload

    POST /vms/e9bd0ed1-7de3-4c66-a649-d675dbce6e83?action=reprovision -d \
    '{ "image_uuid": "01b2c898-945f-11e1-a523-af1afbe22822" }'

### Example with form parameters

    POST /vms/e9bd0ed1-7de3-4c66-a649-d675dbce6e83?action=reprovision \
      -d image_uuid=01b2c898-945f-11e1-a523-af1afbe22822

## UpdateVm (POST /vms/:uuid?action=update)

Similar to CreateVm, this endpoint allows udpating a VM to a new SDC Package. Individual SDC Package related attributes can still be provided if one needs to override specific values. **UpdateVm is only supported for OS VMs**. See
[VM Resize](#vm-resize) for more information.

### Updating VM to an SDC Package

| Param      | Type    | Description                                                                              |
| ---------- | ------- | ---------------------------------------------------------------------------------------- |
| billing_id | UUID    | SDC Package UUID                                                                         |
| force      | Boolean | Force the update even if the Compute Node that hosts the VM doesn't have enough capacity |

The UpdateVm payload would automatically retrieve the following values from the provided SDC Package:

| Param               | Type         |
| ------------------- | ------------ |
| cpu_cap             | Number       |
| max_lwps            | Number       |
| max_physical_memory | Number (MiB) |
| max_swap            | Number (MiB) |
| quota               | Number (GiB) |
| zfs_io_priority     | Number       |
| vcpus               | Number       |

### Updating a VM With Individual VM Values

In addition to 'billing_id', the following values can be specified to update additional attributes of the VM.

| Param                     | Type                          | Description                                                                              |
| ------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| force                     | Boolean                       | Force the udpate even if the Compute Node that hosts the VM doesn't have enough capacity |
| alias                     | String                        | VM alias                                                                                 |
| new_owner_uuid            | UUID                          | UUID of the new VM Owner                                                                 |
| ram                       | Number                        | VM RAM                                                                                   |
| max_physical_memory (MiB) | Number                        | Same as RAM                                                                              |
| max_swap (MiB)            | Number                        | Defaults to 2 x RAM if not specified                                                     |
| zfs_io_priority           | Number                        | ZFS IO Priority                                                                          |
| cpu_cap                   | Number                        | CPU Cap                                                                                  |
| max_lwps                  | Number                        | Max. Lightweight Processes                                                               |
| quota (GiB)               | Number                        | VM quota (disk)                                                                          |
| tags                      | Object                        | VM tags                                                                                  |
| customer_metadata         | Object                        | VM metadata                                                                              |
| internal_metadata         | Object                        | VM metadata                                                                              |
| resolvers                 | Array                         | New set of resolvers for the VM                                                          |
| limit_priv                | String                        | List of priviledges to the VM                                                            |
| fs_allowed                | String (Comma separated list) | Filesystem types that the VM is allowed to mount                                         |

### Advanced Update Inputs

As stated in CreateVm, there are additional advanced properties that can be updated
for a VM. The full set of attributes available for update are listed in the
`VM Object` section in this documentation.

### Example: Renaming a VM and updating its quota

    POST /vms/e9bd0ed1-7de3-4c66-a649-d675dbce6e83?action=update -d '{
        "alias": "new-alias",
        "quota": 20
    }'

### Example: Updating a VM to a new SDC Package

    POST /vms/e9bd0ed1-7de3-4c66-a649-d675dbce6e83?action=update -d '{
        "billing_id": "73a1ca34-1e30-48c7-8681-70314a9c67d3"
    }'

## AddNics (POST /vms/:uuid?action=add_nics)

For adding NICs to a VM, either a `networks` or `macs` list parameter must be
specified (only one, not both). If `networks` is provided, NICs will be created
on the VM and in NAPI which attach to those networks. If `macs` is provided,
NICs will be created on the VM using details from already-created NIC objects in
NAPI.

For more information about the format of `networks`, see 'Specifying Networks
for a VM' in the CreateVM documentation.

| Param    | Type  | Description                                           |
| -------- | ----- | ----------------------------------------------------- |
| networks | Array | List of networks. Same format as CreateVm             |
| macs     | Array | List of MAC addresses of NICs already created in NAPI |

### Example with a JSON payload

    POST /vms/e9bd0ed1-7de3-4c66-a649-d675dbce6e83?action=add_nics -d '{
      "networks": [ { "uuid": "564ded48-c31d-5029-472a-98d5aa9e5a38" } ]
    }'

### Example with form parameters

    POST /vms/e9bd0ed1-7de3-4c66-a649-d675dbce6e83?action=add_nics \
      -d macs=0a:fc:23:10:6e:ff

## UpdateNics (POST /vms/:uuid?action=update_nics)

Updates NICs for a VM. Currently, this action serves three purposes: setting a new primary NIC for a VM, setting antispoof flags for a nic, or reordering its NICs. Each NIC object can only contain the following properties:

| Attribute                | Type        | Description                    |
| ------------------------ | ----------- | ------------------------------ |
| mac                      | MAC Address | NIC MAC Address                |
| interface                | String      | NIC interface/order identifier |
| primary                  | Boolean     | Primary NIC flag               |
| allow_ip_spoofing        | Boolean     | Allow IP spoofing              |
| allow_mac_spoofing       | Boolean     | Allow MAC spoofing             |
| allow_restricted_traffic | Boolean     | Allow unrestricted traffic     |

For the UpdateNics action, a list of at least one NIC object must be specified. If the purpose of the request is to set a new primary NIC, then only one NIC object can have the `primary` attribute set. If the purpose of the request is to reorder the VM NICs, then every NIC object must have its `interface` attribute set and the number of NICs in the array must be the same as the number of NICs the VM currently has. The following table describes the only allowed input for UpdateNics:

| Param | Type  | Description                    |
| ----- | ----- | ------------------------------ |
| nics  | Array | List of NIC objects. See above |

### Example: setting a new primary NIC

    POST /vms/0cb0f7b1-b092-4252-b205-c9c268bfa148?action=update_nics -d '{
      "nics":[{
        "mac": "90:b8:d0:d4:02:f5",
        "primary": true
      }]
    }'

### Example: reordering the VM NICs

    POST /vms/0cb0f7b1-b092-4252-b205-c9c268bfa148?action=update_nics -d '{
      "nics":[{
        "mac": "90:b8:d0:43:56:ba",
        "interface": "net0"
      },{
        "mac": "90:b8:d0:d4:02:f5",
        "interface": "net1"
      }]
    }'


## RemoveNics (POST /vms/:uuid?action=remove_nics)

For removing NICs from a VM, a macs list parameter must be specified. This parameter can be an array of MAC addresses or a comma separated string of MAC addresses.

| Param | Type  | Description           |
| ----- | ----- | --------------------- |
| macs  | Array | List of MAC addresses |

### Example with a JSON payload

    POST /vms/e9bd0ed1-7de3-4c66-a649-d675dbce6e83?action=remove_nics -d '{
      "macs": [ "90:b8:d0:d9:f0:83" ]
    }'

### Example with form parameters

    POST /vms/e9bd0ed1-7de3-4c66-a649-d675dbce6e83?action=remove_nics \
      -d macs=90:b8:d0:d9:f0:83 \


## CreateSnapshot (POST /vms/:uuid?action=create_snapshot)

If a name for the snapshot is not specified, VMAPI will generate a timestamp for its name with the UTC ISO date/time format (without colons or dashes):

    YYYYMMDDTHHMMSSZ

    Example:

    20121018T222506Z

| Param         | Type   | Description                                         |
| ------------- | ------ | --------------------------------------------------- |
| snapshot_name | String | Snapshot name or generated timestamp if not present |

### Example with a JSON payload

    POST /vms/e9bd0ed1-7de3-4c66-a649-d675dbce6e83?action=create_snapshot -d \
    '{ "snapshot_name": "foobar" }'

### Example with form parameters

    POST /vms/e9bd0ed1-7de3-4c66-a649-d675dbce6e83?action=create_snapshot \
      -d snapshot_name=foobar


## DeleteSnapshot (POST /vms/:uuid?action=delete_snapshot)

| Param         | Type   | Description   |
| ------------- | ------ | ------------- |
| snapshot_name | String | Snapshot name |

### Example with a JSON payload

    POST /vms/e9bd0ed1-7de3-4c66-a649-d675dbce6e83?action=delete_snapshot -d \
    '{ "snapshot_name": "foobar" }'

### Example with form parameters

    POST /vms/e9bd0ed1-7de3-4c66-a649-d675dbce6e83?action=delete_snapshot \
      -d snapshot_name=foobar


## RollbackSnapshot (POST /vms/:uuid?action=rollback_snapshot)

If the VM is running at the moment of the request, it will be
shutdown before executing the rollback and be booted again after the rollback
has succeeded.

| Param         | Type   | Description   |
| ------------- | ------ | ------------- |
| snapshot_name | String | Snapshot name |

### Example with a JSON payload

    POST /vms/e9bd0ed1-7de3-4c66-a649-d675dbce6e83?action=rollback_snapshot -d \
    '{ "snapshot_name": "foobar" }'

### Example with form parameters

    POST /vms/e9bd0ed1-7de3-4c66-a649-d675dbce6e83?action=rollback_snapshot \
      -d snapshot_name=foobar



## DeleteVm (DELETE /vms/:uuid)

Deletes a VM. If the VM exists and has a `server_uuid` that refers to an actual
CN that is available, the VM will be physically destroyed and it will be marked
as destroyed in the cache database.

If the VM doesn't have a `server_uuid`, the request will result in an error.

### Inputs

| Param      | Type | Description                                                                                                                                                                                      | Required? |
| ---------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| uuid       | UUID | VM UUID                                                                                                                                                                                          | Yes       |
| uuid       | UUID | VM UUID                                                                                                                                                                                          | Yes       |
| owner_uuid | UUID | VM Owner. If specified, the VM object will be checked for ownership against this owner_uuid. If vm.owner_uuid does not match the provided value the call will result in a 404 VM Not Found error | No        |

### Responses

| Code | Description                                                                  | Response           |
| ---- | ---------------------------------------------------------------------------- | ------------------ |
| 202  | New job created                                                              | VM response object |
| 404  | VM Not Found. VM does not exist or VM does not belong to the specified owner | Error object       |
| 409  | VM not allocated to a server yet                                             | Error object       |

On a successful response, a [VM Job Response Object](#vm-job-response-object) is
returned in the response body.

### Example

    DELETE /vms/e9bd0ed1-7de3-4c66-a649-d675dbce6e83

    HTTP/1.1 202 Accepted
    Connection: close
    workflow-api: http://workflow.coal.joyent.us
    Content-Type: application/json
    Content-Length: 100
    Content-MD5: as77tkERx4gj7igpE83PyQ==
    Date: Mon, 24 Apr 2017 22:30:44 GMT
    Server: VMAPI
    x-request-id: d169bbdf-a54c-4f71-a543-8928cda5b152
    x-response-time: 170
    x-server-name: d6334b70-2e19-4af4-85ba-53776ef82820

    {
      "vm_uuid": "e9bd0ed1-7de3-4c66-a649-d675dbce6e83",
      "job_uuid": "56aca67a-5374-4117-9817-6ac77060697e"
    }

# VM Metadata

There are three kinds of metadata a VM can store: customer_metadata, internal_metadata and tags. A metadata object is any valid set of key/value pairs that can be properly encoded to JSON. Values must be strings, numbers or booleans. Examples:

    {
      "ip": "10.99.99.9",
      "boolean": true,
      "string": "foobar",
      "number": 42
    }

VM Tags allow VMs to be grouped by any criteria. Tags are key/value pairs that can be assigned to any VM. For example, VMs can be grouped by tagging them as a database role with a tag such as '{ role: "database" }'.

Customer and internal metadata are used to store relevant information to the VM, such as IP addresses of dependent VMs or initialization scripts that run when the VM is being setup.

The following API endpoints are equivalent for tags, customer_metadata and internal_metadata since all three metadata types share the same representation.


## ListMetadata (GET /vms/:uuid/(tags|customer_metadata|internal_metadata))

Returns metadata assigned to a VM.

### Inputs

| Param      | Type | Description | Required? |
| ---------- | ---- | ----------- | --------- |
| uuid       | UUID | VM UUID     | Yes       |
| owner_uuid | UUID | VM Owner    | No        |

### Responses

| Code | Description                                                                  | Response        |
| ---- | ---------------------------------------------------------------------------- | --------------- |
| 200  |                                                                              | Metadata object |
| 404  | VM Not Found. VM does not exist or VM does not belong to the specified owner | Error object    |

### Example

    GET /vms/da0dfac1-341e-4e51-b357-99f7355f1008/tags

    {
      "role": "dns",
      "customer": "tracy"
    }


## GetMetadata (GET /vms/:uuid/(tags|customer_metadata|internal_metadata)/:key)

Returns the value of a metadata key.

### Inputs

| Param      | Type   | Description  | Required? |
| ---------- | ------ | ------------ | --------- |
| uuid       | UUID   | VM UUID      | Yes       |
| owner_uuid | UUID   | VM Owner     | No        |
| key        | String | Metadata Key | Yes       |

### Responses

| Code | Description                                                                  | Response                         |
| ---- | ---------------------------------------------------------------------------- | -------------------------------- |
| 200  |                                                                              | String value of the metadata key |
| 404  | VM Not Found. VM does not exist or VM does not belong to the specified owner | Error object                     |

### Example

    GET /vms/da0dfac1-341e-4e51-b357-99f7355f1008/tags/role

    dns


## AddMetadata (POST /vms/:uuid/(tags|customer_metadata|internal_metadata))

Adds a new metadata to a VM. Keep in mind that metadata gets appended, not overwritten.

### Inputs

| Param      | Type             | Description | Required? |
| ---------- | ---------------- | ----------- | --------- |
| uuid       | UUID             | VM UUID     | Yes       |
| owner_uuid | UUID             | VM Owner    | No        |
| metadata   | key-value/object | Metadata    | Yes       |

### Responses

| Code | Description                                                                  | Response           |
| ---- | ---------------------------------------------------------------------------- | ------------------ |
| 202  | New job created                                                              | VM response object |
| 404  | VM Not Found. VM does not exist or VM does not belong to the specified owner | Error object       |

### Example

    POST /vms/da0dfac1-341e-4e51-b357-99f7355f1008/tags
      -d customer=tracy
    POST /vms/da0dfac1-341e-4e51-b357-99f7355f1008/tags
      --data-binary '{ "customer": "tracy" }'


## SetMetadata (PUT /vms/:uuid/(tags|customer_metadata|internal_metadata))

Sets new metadata to a VM. The provided metadata object replaces the current
one present in the VM.

### Inputs

| Param      | Type             | Description | Required? |
| ---------- | ---------------- | ----------- | --------- |
| uuid       | UUID             | VM UUID     | Yes       |
| owner_uuid | UUID             | VM Owner    | No        |
| metadata   | key-value/object | Metadata    | Yes       |

### Responses

| Code | Description                                                                  | Response           |
| ---- | ---------------------------------------------------------------------------- | ------------------ |
| 202  | New job created                                                              | VM response object |
| 404  | VM Not Found. VM does not exist or VM does not belong to the specified owner | Error object       |

### Example

    PUT /vms/da0dfac1-341e-4e51-b357-99f7355f1008/tags
      -d customer=tracy
    PUT /vms/da0dfac1-341e-4e51-b357-99f7355f1008/tags
      --data-binary '{ "customer": "tracy" }'


## DeleteMetadata (DELETE /vms/:uuid/(tags|customer_metadata|internal_metadata)/:key)

Deletes a metadata key from a VM.

### Inputs

| Param      | Type   | Description  | Required? |
| ---------- | ------ | ------------ | --------- |
| uuid       | UUID   | VM UUID      | Yes       |
| owner_uuid | UUID   | VM Owner     | No        |
| key        | String | Metadata Key | Yes       |

### Responses

| Code | Description                                                                  | Response           |
| ---- | ---------------------------------------------------------------------------- | ------------------ |
| 202  | New job created                                                              | VM response object |
| 404  | VM Not Found. VM does not exist or VM does not belong to the specified owner | Error object       |

### Example

    DELETE /vms/da0dfac1-341e-4e51-b357-99f7355f1008/tags/role


## DeleteAllMetadata (DELETE /vms/:uuid/(tags|customer_metadata|internal_metadata))

Deletes all metadata keys from a VM.

### Inputs

| Param      | Type | Description | Required? |
| ---------- | ---- | ----------- | --------- |
| uuid       | UUID | VM UUID     | Yes       |
| owner_uuid | UUID | VM Owner    | No        |

### Responses

| Code | Description                                                                  | Response           |
| ---- | ---------------------------------------------------------------------------- | ------------------ |
| 202  | New job created                                                              | VM response object |
| 404  | VM Not Found. VM does not exist or VM does not belong to the specified owner | Error object       |

### Example

    DELETE /vms/da0dfac1-341e-4e51-b357-99f7355f1008/tags






# VM Role Tags

Role Tags is a role based access control (RBAC) feature for Manta and CloudAPI.
At the VMAPI level, VMs can be assigned a list of role tags (UUID strings) and
then the API exposes functionality to allow searching for VMs that match a
specific list of role UUIDs. The use of role tags doesn't have any effects on
the lifecycle of VMs and doesn't make physical changes to them either. The use
of this feature is optional.

## CreateVm With Role Tags

CreateVm also accepts a role_tags parameter in order to provision a VM that
will have role tags assigned from the moment it starts running. Role tags for
new VMs are specified in the request body of the CreateVm request call exactly
the same way as other allowed parameters.

### Inputs

| Param     | Type                                   | Description |
| --------- | -------------------------------------- | ----------- |
| role_tags | String (comma-separated list of UUIDs) | Role Tags   |

### Example CreateVm Call with Role Tags

    POST /vms -d '{
      "owner_uuid": "930896af-bf8c-48d4-885c-6573a94b1853",
      "image_uuid": "28445220-6eac-11e1-9ce8-5f14ed22e782",
      "brand": "joyent",
      "networks": ["a4457fc9-c415-4ac9-8738-a03b1a8e7aee"],
      "ram": 128,
      "quota": 10,
      "role_tags": ["fd48177c-d7c3-11e3-9330-28cfe91a33c9"]
    }'

## ListVms With Role Tags

ListVms accepts a role_tags query parameter that enables filtering all VMs that
match one or more role_tags provided. Since VM objects are returned without
role_tags by default, clients need to additionally pass which fields they want
to be returned as part of the response, should they need each VM's role_tags in
addition to their default properties.

### Inputs

| Param     | Type                                   | Description                       |
| --------- | -------------------------------------- | --------------------------------- |
| role_tags | String (comma-separated list of UUIDs) | Role Tags                         |
| fields    | String (comma-separated values)        | Specify which VM fields to return |

### Responses

| Code | Description       | Response            |
| ---- | ----------------- | ------------------- |
| 200  | Response OK       | Array of VM objects |
| 409  | Invalid Role Tags | Error object        |

### Examples

Specify one or more role_tags:

    GET /vms?role_tags=c4cbe913-f15a-4232-985b-950c23d68873

    HTTP/1.1 200 OK
    x-joyent-resource-count: 1
    Connection: close
    Content-Type: application/json
    Content-Length: 1047
    Content-MD5: DE97n7WReix5z/TC4B/zig==
    Date: Fri, 18 Apr 2014 00:00:28 GMT
    Server: VMAPI
    ...

    [
      {
        "uuid": "6cfa6474-d838-42ef-9f38-4e66b604deb7",
        "alias": null,
        "autoboot": true,
        "brand": "joyent-minimal",
    ...

    GET /vms?role_tags=c4cbe913-f15a-4232-985b-950c23d68873,f8b5ed20-c598-11e3-8bd4-f74769a100ec
    HTTP/1.1 200 OK
    x-joyent-resource-count: 2
    Connection: close
    Content-Type: application/json
    Content-Length: 3119
    Content-MD5: ePnd9pbA/jcxugimI9Flyw==
    Date: Fri, 18 Apr 2014 00:01:44 GMT
    Server: VMAPI
    ...

    [
      {
        "uuid": "c4cbe913-f15a-4232-985b-950c23d68873",
        "alias": "adminui0",
        "autoboot": true,
        "brand": "joyent-minimal",
        ...
        ...
        ...
      },
      {
        "uuid": "6cfa6474-d838-42ef-9f38-4e66b604deb7",
        "alias": null,
        "autoboot": true,
        "brand": "joyent-minimal",
        ...
        ...
        ...
      }
    ]

Return role_tags and additional fields for every VM object:

    GET /vms?role_tags=c4cbe913-f15a-4232-985b-950c23d68873,f8b5ed20-c598-11e3-8bd4-f74769a100ec&fields=uuid,state,role_tags
    HTTP/1.1 200 OK
    x-joyent-resource-count: 2
    Connection: close
    Content-Type: application/json
    Content-Length: 241
    Content-MD5: G/U2xT9peoZ8ZozkH60ZEg==
    Date: Fri, 18 Apr 2014 00:03:38 GMT
    Server: VMAPI
    ...

    [
      {
        "uuid": "c4cbe913-f15a-4232-985b-950c23d68873",
        "state": "running",
        "role_tags": [
          "f8b5ed20-c598-11e3-8bd4-f74769a100ec"
        ]
      },
      {
        "uuid": "6cfa6474-d838-42ef-9f38-4e66b604deb7",
        "state": "destroyed",
        "role_tags": [
          "c4cbe913-f15a-4232-985b-950c23d68873"
        ]
      }
    ]

## GetVm With Role Tags

Similarly to ListVms, The VM object returned by GetVm doesn't have a role_tags
attribute by default, clients need to make that explicity via the fields query
parameter.


### Inputs

| Param  | Type                            | Description                       |
| ------ | ------------------------------- | --------------------------------- |
| fields | String (comma-separated values) | Specify which VM fields to return |

### Responses

| Code | Description       | Response     |
| ---- | ----------------- | ------------ |
| 200  | Response OK       | VM object    |
| 409  | Invalid Role Tags | Error object |

### Example

Return basic VM attributes in addition to role_tags

    GET /vms/c4cbe913-f15a-4232-985b-950c23d68873?fields=uuid,alias,ram,state,nics,role_tags

    HTTP/1.1 200 OK
    Content-Type: application/json
    Content-Length: 294
    Content-MD5: eNeaJ38SPtlU8Xa4osHgrg==
    Date: Mon, 21 Apr 2014 17:31:40 GMT
    Server: VMAPI
    ...

    {
      "uuid": "c4cbe913-f15a-4232-985b-950c23d68873",
      "alias": "adminui0",
      "ram": 2048,
      "state": "running",
      "nics": [
        {
          "interface": "net0",
          "mac": "82:6e:d6:5c:e4:36",
          "vlan_id": 0,
          "nic_tag": "admin",
          "ip": "10.99.99.32",
          "netmask": "255.255.255.0",
          "primary": true
        }
      ],
      "role_tags": [
        "f8b5ed20-c598-11e3-8bd4-f74769a100ec"
      ]
    }


## AddRoleTags (POST /vms/:uuid/role_tags)

Appends one or more role tags to a VM.

### Inputs

| Param      | Type          | Description | Required? |
| ---------- | ------------- | ----------- | --------- |
| uuid       | UUID          | VM UUID     | Yes       |
| owner_uuid | UUID          | VM Owner    | No        |
| role_tags  | Array of UUID | Role Tags   | Yes       |

### Responses

| Code | Description                                                                  | Response                    |
| ---- | ---------------------------------------------------------------------------- | --------------------------- |
| 200  | Response OK. Role Tags Added                                                 | VM Role Tags. Array of UUID |
| 404  | VM Not Found. VM does not exist or VM does not belong to the specified owner | Error object                |
| 409  | Invalid Role Tags                                                            | Error object                |

### Example

    POST /vms/a1593802-79c9-4bf1-a7af-c6d43a36852c/role_tags
      -d '{ "role_tags": ["d034f9e0-c97b-11e3-a970-7bd3b454fb1a"] }'

    [
      "b6368edf-464f-4c72-a134-a21bb6bae434",
      "d034f9e0-c97b-11e3-a970-7bd3b454fb1a"
    ]


## SetRoleTags (PUT /vms/:uuid/role_tags)

Sets new role tags for a VM.

### Inputs

| Param      | Type          | Description | Required? |
| ---------- | ------------- | ----------- | --------- |
| uuid       | UUID          | VM UUID     | Yes       |
| owner_uuid | UUID          | VM Owner    | No        |
| role_tags  | Array of UUID | Role Tags   | Yes       |

### Responses

| Code | Description                                                                  | Response                        |
| ---- | ---------------------------------------------------------------------------- | ------------------------------- |
| 200  | Response OK. Role Tags Replaced                                              | New VM Role Tags. Array of UUID |
| 404  | VM Not Found. VM does not exist or VM does not belong to the specified owner | Error object                    |
| 409  | Invalid Role Tags                                                            | Error object                    |


### Example

    PUT /vms/a1593802-79c9-4bf1-a7af-c6d43a36852c/role_tags
      -d '{ "role_tags": ["d034f9e0-c97b-11e3-a970-7bd3b454fb1a"] }'

    [
      "d034f9e0-c97b-11e3-a970-7bd3b454fb1a"
    ]


## DeleteRoleTag (DELETE /vms/:uuid/role_tags/:role_tag)

Deletes a role tag from a VM.

### Inputs

| Param      | Type | Description | Required? |
| ---------- | ---- | ----------- | --------- |
| uuid       | UUID | VM UUID     | Yes       |
| owner_uuid | UUID | VM Owner    | No        |
| role_tag   | UUID | Role Tag    | Yes       |

### Responses

| Code | Description                                                                                        | Response                        |
| ---- | -------------------------------------------------------------------------------------------------- | ------------------------------- |
| 200  | Response OK. Role Tag removed                                                                      | New VM Role Tags. Array of UUID |
| 404  | VM or Role Tag Not Found. VM or Role Tag do not exist or VM does not belong to the specified owner | Error object                    |

### Example

    DELETE /vms/a1593802-79c9-4bf1-a7af-c6d43a36852c/role_tags/d034f9e0-c97b-11e3-a970-7bd3b454fb1

    [
      "b6368edf-464f-4c72-a134-a21bb6bae434"
    ]


## DeleteAllRoleTags (DELETE /vms/:uuid/role_tags)

Deletes all role tags from a VM.

### Inputs

| Param      | Type | Description | Required? |
| ---------- | ---- | ----------- | --------- |
| uuid       | UUID | VM UUID     | Yes       |
| owner_uuid | UUID | VM Owner    | No        |

### Responses

| Code | Description                                                                  | Response         |
| ---- | ---------------------------------------------------------------------------- | ---------------- |
| 200  | Response OK. Role Tags removed                                               | No response body |
| 404  | VM Not Found. VM does not exist or VM does not belong to the specified owner | Error object     |

### Example

    DELETE /vms/da0dfac1-341e-4e51-b357-99f7355f1008/tags


# Jobs

Jobs are created when an operation needs to be performed on a VM. Examples of jobs that can be created are VM lifecycle tasks such as start and reboot. Provision jobs are created from calling "POST /vms".


## ListJobs (GET /jobs)

Returns all jobs matching the specified search filters.

### Inputs

| Param     | Type   | Description                      | Required? |
| --------- | ------ | -------------------------------- | --------- |
| vm_uuid   | UUID   | Return all jobs for this VM UUID | No        |
| execution | String | Job state. See below             | No        |
| task      | String | Type of job. See below           | No        |

### Job 'execution' State Inputs

| Execution |
| --------- |
| running   |
| succeeded |
| failed    |

### Job 'task' Type Inputs

**NOTE** Any metadata endpoint that returns a Job response object is an 'update'
job for the backend system.

| Task      |
| --------- |
| provision |
| start     |
| stop      |
| reboot    |
| update    |
| destroy   |

### Example

    GET /jobs?execution=failed
    GET /jobs?task=provision


## ListVmJobs (GET /vms/:uuid/jobs)

Returns all VM jobs matching the specified search filters. This is the same
implementation as the previous endpoint, but with a more convenient path when
the VM UUID is known.

### Inputs

| Param     | Type   | Description                      | Required? |
| --------- | ------ | -------------------------------- | --------- |
| uuid      | UUID   | Return all jobs for this VM UUID | No        |
| execution | String | Job state. See above             | No        |
| task      | String | Type of job. See above           | No        |

### Example

    GET /vms/da0dfac1-341e-4e51-b357-99f7355f1008/jobs?execution=failed
    GET /vms/da0dfac1-341e-4e51-b357-99f7355f1008/jobs?task=provision


## GetJob (GET /jobs/:uuid)

Returns a job with the specified UUID.

### Inputs

| Param | Type | Description | Required? |
| ----- | ---- | ----------- | --------- |
| uuid  | UUID | Job UUID    | Yes       |

### Example

    GET /jobs/6ad3a288-31cf-44e0-8d18-9b3f2a031067

    {
      "name": "provision-4e4ff04b-5cc4-437e-92da-2403a634e74f",
      "uuid": "6ad3a288-31cf-44e0-8d18-9b3f2a031067",
      "execution": "succeeded",
      "params": {
        "owner_uuid": "930896af-bf8c-48d4-885c-6573a94b1853",
        "image_uuid": "28445220-6eac-11e1-9ce8-5f14ed22e782",
        "brand": "joyent",
        "ram": "128",
        "zonename": "e9bd0ed1-7de3-4c66-a649-d675dbce6e83",
        "uuid": "e9bd0ed1-7de3-4c66-a649-d675dbce6e83",
        "server_uuid": "564da914-5047-48f0-ba5e-26761097330a",
        "task": {
          "id": "70129767",
          "progress": 100,
          "status": "complete"
        }
      },
      "exec_after": "2012-04-13T18:17:15.194Z",
      "created_at": "2012-04-13T18:17:15.198Z",
      "timeout": 180,
      "chain_results": [
        {
          "result": "All parameters OK!",
          "error": "",
          "started_at": "2012-04-13T18:17:17.512Z",
          "finished_at": "2012-04-13T18:17:18.619Z"
        },
        {
          "result": "Got servers!",
          "error": "",
          "started_at": "2012-04-13T18:17:18.628Z",
          "finished_at": "2012-04-13T18:17:21.737Z"
        },
        {
          "result": "Server allocated!",
          "error": "",
          "started_at": "2012-04-13T18:17:21.743Z",
          "finished_at": "2012-04-13T18:17:23.137Z"
        },
        {
          "result": "Provision succeeded!",
          "error": "",
          "started_at": "2012-04-13T18:17:23.197Z",
          "finished_at": "2012-04-13T18:18:42.726Z"
        }
      ]
    }


# Running Status for VMs

When querying one of the VM endpoints such as the single and collection VM URLs, the 'state' attribute of the VM object let us know what is the running status of the machine. In addition to this, a '/statuses' endpoint is provided to give information about specific VM UUIDs instead of returning VM objects for machines that satisfy a search criteria.

## ListStatuses (GET /statuses)

Returns the running status for all of the VM UUIDs specified in the request parameters.

### Inputs

| Param | Type           | Description                   | Required? |
| ----- | -------------- | ----------------------------- | --------- |
| uuids | Array of UUIDs | Comma separated list of UUIDs | Yes       |

### Note

When one of the UUIDs in the request parameters corresponds to a machine that does not exist, it is ignored in the response object instead of returning null.

### Example

    GET /statuses?uuids=54e21a72-5921-4c5a-92db-fb662c8a812a,4f11fbab-dcc0-483f-bb14-e1434465032a

    {
      "54e21a72-5921-4c5a-92db-fb662c8a812a": "running",
      "4f11fbab-dcc0-483f-bb14-e1434465032a": "stopped"
    }



# Operator Guide

This section is intended to give necessary information for diagnosing and
dealing with issues with VMAPI in a SmartDataCenter installation.

There is one VMAPI service per datacenter. There might actually be more than
one "vmapi" zone for HA. Use this to list the vmapi zones in a DC:

    sdc-vmapi /vms?owner_uuid=$(bash /lib/sdc/config.sh -json | json ufds_admin_uuid) \
        | json -H -c "this.tags.smartdc_role=='vmapi'"


## VMAPI Configuration File

By default, VMAPI's configuration file is located at "./config.json". Any value
in the table below that has a default value can be overrided in the configuration
file. Note that this file should only be modified if any other service depending
on VMAPI is updated as well.

| var                    | type             | default         | description                                                    |
| ---------------------- | ---------------- | --------------- | -------------------------------------------------------------- |
| port                   | Number           | 80              | Port number on which to listen.                                |
| logLevel               | String or Number | debug           | Level at which to log. One of the supported Bunyan log levels. |
| maxSockets             | Number           | 100             | Maximum number of sockets for external API calls               |
| api                    | Object           | -               | VMAPI configuration                                            |
| api.port               | Number           | -               | VMAPI port                                                     |
| wfapi                  | Object           | -               | WFAPI configuration                                            |
| wfapi.url              | String           | -               | WFAPI URL                                                      |
| wfapi.forceReplace     | Boolean          | false           | Replace workflows every time VMAPI restarts                    |
| wfapi.workflows        | Array            | -               | List of workflows to load on start                             |
| cnapi                  | Object           | -               | CNAPI configuration                                            |
| cnapi.url              | String           | -               | CNAPI URL                                                      |
| napi                   | Object           | -               | NAPI configuration                                             |
| napi.url               | String           | -               | NAPI URL                                                       |
| moray                  | Object           | -               | Moray configuration                                            |
| moray.host             | String           | -               | Moray hostname                                                 |
| moray.port             | Number           | -               | Moray port                                                     |
| moray.connectTimeout   | Number           | -               | Moray connection timeout                                       |
| moray.retry            | Object           | -               | Moray retry object                                             |
| moray.retry.minTimeout | Number           | -               | Moray minimum retry timeout                                    |
| moray.retry.maxTimeout | Number           | -               | Moray maximum retry timeout                                    |
| docker_tag_re          | String           | -               | Tags matching regex are treated with Docker tag semantics      |


## SAPI Configuration

When using the config-agent service in a VMAPI zone, which draws metadata from
SAPI, it's possible to change some of the defaults outlined in the
`VMAPI Configuration File` section above.

In the SAPI "vmapi" service, adding or changing the following keys in
`metadata` can change some VMAPI behaviours for specialized circumstances in
production.

| Key                            | Type   | Description                                                                  |
| ------------------------------ | ------ | ---------------------------------------------------------------------------- |
| **experimental_fluentd_host**  | String |                                                                              |
| **docker_tag_re**              | String | Tags matching regex are treated with Docker tag semantics                    |

`docker_tag_re` must be a valid regular expression string -- more concretely,
what Javascript's RegExp() considers valid. Docker tags can be added during
provisioning, but otherwise cannot later be altered or removed, and may have
special significance to Docker. It's recommended to not change `docker_tag_re`
unless you're aware of the semantics and effects of Docker tags.


## Health

As seen in the API actions documentation, VMAPI has a "/ping" endpoint to
indicate if it is up

    $ sdc-vmapi /ping

or if there are multiple VMAPI servers:

    $ for ip in $(bash /lib/sdc/config.sh -json | json vmapi_admin_ips | tr ',' ' '); do \
        echo "# $ip" ; \
        curl -sS http://$ip/ping | json ; \
    done


## Logs

TODO: how to dynamically change log levels

VMAPI is a single SMF service that operates on a SmartOS VM. The following is the
location/command for accessing the log file written by the VMAPI service:

| service/path | where | format | tail -f |
| ------------ | ----- | ------ | ------- |
| vmapi | in each "vmapi" zone | [Bunyan](https://github.com/trentm/node-bunyan) | `` sdc-login vmapi; tail -f `svcs -L vmapi` | bunyan `` |

Note that the logs for the VMAPI service are rotated, so one might need the
directory where these files are being written in case older log files contain the
information that we are looking for. Use the following command to find the
directory where the VMAPI SMF service writes its files:


## Analysing Logs

VMAPI uses Bunyan as its logging module. This allows users to find useful
debugging information in a very straightforward way since each log message
produced by Bunyan is a JSON object. VMAPI logs are structured so that they can
be filtered by component, API action, VM UUID and Server UUID when using the
`bunyan` command line utility.

The following are the components that describe each of the pieces in the VMAPI
application and allow for more specific log filtering:

| Component Name | Description                                                  |
| -------------- | ------------------------------------------------------------ |
| api            | API requests/responses                                       |
| napi           | NIC add/removal activity                                     |
| cnapi          | machine_load requests/responses                              |
| wfapi          | WFAPI requests/responses (for queueing VM jobs)              |
| moray          | Moray database operations (read/write VM data)               |

In order to filter a VMAPI log file by component we make use of Bunyan's '-c'
option:

    -c, --condition CONDITION
                  Run each log message through the condition and
                  only show those that return truish. E.g.:
                      -c 'this.pid == 123'
                      -c 'this.level == DEBUG'
                      -c 'this.msg.indexOf("boom") != -1'
                  'CONDITION' must be legal JS code. `this` holds
                  the log record. The TRACE, DEBUG, ... FATAL values
                  are defined to help with comparing `this.level`.

The 'this' variable inside a condition refers to the JSON object that was logged
by Bunyan at any given point in time. If we wanted to see all messages that have
been produced by the moray module we would issue the following command:

    cat /var/svc/log/smartdc-site-vmapi\:default.log | bunyan -c "this.component === 'wfapi'"
    ...
    [2015-11-23T19:28:00.755Z]  INFO: vmapi/wfapi/14012 on e1c43507-9923-47d2-926f-2bba86963cac: Connected to Workflow API
    [2015-11-23T19:28:00.873Z] DEBUG: vmapi/wfapi/14012 on e1c43507-9923-47d2-926f-2bba86963cac: provision-7.2.6 workflow exists
    [2015-11-23T19:28:00.895Z] DEBUG: vmapi/wfapi/14012 on e1c43507-9923-47d2-926f-2bba86963cac: start-7.0.6 workflow exists
    [2015-11-23T19:28:00.918Z] DEBUG: vmapi/wfapi/14012 on e1c43507-9923-47d2-926f-2bba86963cac: stop-7.0.7 workflow exists
    [2015-11-23T19:28:00.929Z] DEBUG: vmapi/wfapi/14012 on e1c43507-9923-47d2-926f-2bba86963cac: kill-7.0.1 workflow exists
    ...

Bunyan still allows us to filter logs by level, so in case we were looking for
an exception produced while starting up the workflow connection we can do the
following:

    cat /var/svc/log/smartdc-site-vmapi\:default.log | bunyan -c "this.component === 'wfapi'" -l error
    ...
    [2015-11-23T19:27:07.588Z] ERROR: vmapi/wfapi/14012 on e1c43507-9923-47d2-926f-2bba86963cac: Ping failed
        error: {
          "code": "ENOTFOUND",
          "errno": "ENOTFOUND",
          "syscall": "getaddrinfo"
        }
    [2015-11-23T19:27:07.589Z] ERROR: vmapi/wfapi/14012 on e1c43507-9923-47d2-926f-2bba86963cac: Ping failed
        error: {
          "code": "ENOTFOUND",
          "errno": "ENOTFOUND",
          "syscall": "getaddrinfo"
        }
    ...


### Filtering specific VM activity

In addition to components, logs can be filtered by VM UUID and API action. This
enables operators to better track all the API actions called for a VM of
interest.

Again, by using the '-c' option in Bunyan, we use the vm_uuid attribute to find
all log entries related to a single VM:

    cat tmp/local.log | bunyan -c "this.vm_uuid === '0c81af15-d3b2-47f9-a75a-db7f16a65434'"

    [2013-03-12T16:46:23.091Z] TRACE: vmapi/api/79487: GetVm start (vm_uuid=0c81af15-d3b2-47f9-a75a-db7f16a65434)
    [2013-03-12T16:46:23.092Z]  INFO: vmapi/api/79487: handled: 200 (vm_uuid=0c81af15-d3b2-47f9-a75a-db7f16a65434, audit=true, remoteAddress=127.0.0.1, remotePort=65466, latency=11, _audit=true, req.body="")
        GET /vms/0c81af15-d3b2-47f9-a75a-db7f16a65434?owner_uuid=00000000-0000-0000-0000-000000000000 HTTP/1.1
        accept: application/json
        user-agent: restify/2.2.2 (x64-darwin; v8/3.11.10.25; OpenSSL/1.0.0f) node/0.8.18
        accept-version: *
        date: Tue, 12 Mar 2013 16:46:23 GMT
        host: localhost:8080
        connection: close
        ...
        ...
    [2013-03-12T16:46:23.105Z] TRACE: vmapi/api/79487: DeleteVm start (vm_uuid=0c81af15-d3b2-47f9-a75a-db7f16a65434)

If there were both API and other log records for the VM in question. Going
further we could filter this information by adding an additional component
condition like:

    cat tmp/local.log | bunyan -c "this.vm_uuid === '0c81af15-d3b2-47f9-a75a-db7f16a65434' && this.component === 'api'"

Now, if we wanted to focus our attention on specific API actions for a VM we can
also filter logs by route name. The following is a list of API actions in VMAPI
that can be filtered in the logs. The route name to be used for the Bunyan
utility is just the lower case version of the API action that can be found on
this documentation. Note that some routes accept a vm_uuid parameter when they
are actions specific to a single VM and not a collection of VMs.

| API Action       | Route Name        | Accepts vm_uuid? |
| ---------------- | ----------------- | ---------------- |
| ListVms          | listvms           | No               |
| CreateVm         | createvm          | No               |
| GetVm            | getvm             | Yes              |
| StartVm          | startvm           | Yes              |
| StopVm           | stopvm            | Yes              |
| RebootVm         | rebootvm          | Yes              |
| ChangeVm         | changevm          | Yes              |
| DeleteVm         | deletevm          | Yes              |
| AddNics          | addnics           | Yes              |
| RemoveNics       | removenics        | Yes              |
| CreateSnapshot   | createsnapshot    | Yes              |
| RollbackSnapshot | rollbacksnapshot  | Yes              |
| DeleteSnapshot   | deletesnapshot    | Yes              |
| ListMetadata     | listmetadata      | Yes              |
| GetMetadata      | getmetadata       | Yes              |
| AddMetadata      | addmetadata       | Yes              |
| SetMetadata      | setmetadata       | Yes              |
| DeleteMetadata   | deletemetadata    | Yes              |
| DeleteMetadata   | deleteallmetadata | Yes              |

As an example, we can run this command to get the logs of all the GetVm calls to
VMAPI:

    cat tmp/local.log | bunyan -c "this.route === 'getvm'"

    [2013-03-13T21:12:00.788Z]  INFO: vmapi/api/91013 on Andres-Rodriguezs-MacBook-Pro.local: handled: 200 (vm_uuid=00b70fd9-731d-4c9c-bf9a-7f859bf6c3cf, route=getvm, audit=true, remoteAddress=127.0.0.1, remotePort=61123, latency=21, _audit=true, req.body="")
        GET /vms/00b70fd9-731d-4c9c-bf9a-7f859bf6c3cf HTTP/1.1
        user-agent: curl/7.27.0
        host: 0.0.0.0:8080
        accept: */*
        --
        HTTP/1.1 200 OK
        content-type: application/json
        content-length: 7842
        content-md5: Z+XMCqoiyRTX0Oy88MJA9Q==
    ...
    ...


## Use Cases and Examples

The following examples make use of the `json` tool (https://github.com/trentm/json)
as a very convenient way to "pretty print" the output produced by VMAPI. In addition,
we assume VMAPI is being queried from an SDC Compute Node, thus implying the availability
of the sdc-vmapi command.

### Counting VMs

Use the HEAD HTTP method to get the number of VMs that match a specific criteria.
If HEAD is used, VMAPI won't return any objects as specified by the HTTP standard.
The number of VMs that match the query will be available as the **x-joyent-resource-count**
response header

*Count all VMs:*

    sdc-vmapi /vms -X HEAD

    HTTP/1.1 200 OK
    x-joyent-resource-count: 21
    Connection: close
    Date: Tue, 26 Mar 2013 09:54:21 GMT

*Count all 128M Vms:*

    sdc-vmapi /vms -X HEAD

    HTTP/1.1 200 OK
    x-joyent-resource-count: 8
    Connection: close
    Date: Tue, 26 Mar 2013 09:54:21 GMT

### Query String vs LDAP Search Query

Use a query string when you need to match specific values for VM attributes.
Examples of this are "ram=128" or "alias=my-vm". This is the classic behavior
for passing data values to an HTTP API and it allows client UIs to have tables
that display data that can be filtered by any given attribute.

VMAPI also allows clients to pass an LDAP search query that can be used when just
the equality operator is not enough. As an example, one might neeed to get the
UUIDs of all machines that have less than or equal to 256M of RAM:

    sdc-vmapi "/vms?query=(ram<=256)" | json -H -a uuid ram

    6472ed54-0783-4b2a-b052-ed2991284314 256
    c6de897f-c5af-4dd2-9659-c1893c95ca31 128
    20aaee31-7f94-4a5a-b724-48a5b42d4066 128
    dfcbc0d4-b423-4f13-9583-d6e87aae5801 256
    cc57ab8b-1f50-4779-828a-2a0109aed360 256
    d848d326-2502-4200-ace8-8830259f4ef1 128
    ae21f197-a005-476f-9423-b5d63279686f 128
    b95db5f7-8b02-472c-a6cc-719bc7566b2a 128
    47c36d58-b5b8-4e4d-a505-080feeea3386 128
    a564b236-b158-4231-b060-9a24ba0c257e 128
    720426ef-82de-4289-9813-44f0badf0b06 128

Or we can also find all the machines created in a period of time:

    sdc-vmapi "/vms?query=(%26(create_timestamp<=1364329137198)(create_timestamp>=1354321137198))" | json -H -a alias

    assets0
    sapi0
    zookeeper0
    manatee0
    moray0
    redis0
    ufds0
    workflow0
    amon0
    napi0
    rabbitmq0
    imgapi0
    cnapi0
    dhcpd0
    dapi0
    fwapi0
    vmapi0
    ca0
    adminui0

TODO: modifying vms

## Debugging Common Issues

### VMAPI has no VMs, or VMs are not being updated

This is almost always an issue with the vm-agent, since VMAPI should always
have VMs. Even if VMs are not created from VMAPI they are discovered by the
vm-agent.

**What To Do?**

* Make sure the vm-agents on your CNs are not having problem to process data.
Check the vm-agent service logs on the CNs and then check the VMAPI service log
file in the VMAPI zone and see if there are any errors being logged in it.

* If vm-agent is having problems, it is recommended that you take a gcore of the
  vm-agent node process and then restart the vm-agent service.

TODO: job failed

TODO: provision failed

TODO: vm destroyed but still there


# Changelog

## Changes post 2014-07-31

  * See: https://github.com/joyent/sdc-vmapi/commits/master

## 2014-07-31

  * Added search predicate support to GET /vms

## 2014-04-28

  * Added wildcard ('*') support for `fields` query parameter

## 2014-04-17

  * Added support for VM Role Tags
  * Added support for `fields` query parameter in ListVms and GetVm

## 2013-11-29

  * Added *wfapi* to *services* property in /ping response

## 2013-04-30

  * Property *resolvers* added to VM response object

## 2013-04-29

  * Added *reprovision* action to POST /vms/:uuid

## 2013-03-11

  * Added *status* to /ping response

## 2013-02-04

  * Added process *pid* to /ping response

## 2012-12-18

  * Added support for delete_snapshot
  * Updated endpoints for create_snapshot and rollback_snapshot. They are now part of UpdateVm

## 2012-12-13

  * Added support add_nics and remove_nics on UpdateVm

## 2012-11-30

  * Added support for advanced search on ListVms (LDAP search filters)

## 2012-11-21

  * New /ping endpoint to report on service status

## 2012-11-19

  * VM response object now returns the snapshot property for vms

## 2012-11-08

  * updateVm endpoint now takes new_owner_uuid instead of owner_uuid to indicate the new owner of the VM

## 2012-10-18

  * Added snapshot and rollback support

## 2012-09-11

  * Updating VM metadata with an updateVm operation replaces existing metadata. It is no longer an append

## 2012-08-29

  * Adds an error response when trying to delete unallocated VMs

## 2012-08-10

  * Added new format for networks parameter in CreateVm. See deprecation note

## 2012-08-08

  * Added /statuses

## 2012-06-12

  * Added /jobs and /vms/:uuid/jobs

## 2012-06-11

  * dataset_uuid is deprecated. image_uuid should now be used
  * Added SetMetadata (PUT /vms/:uuid/:metadata)

## 2012-06-07

  * Reverted dataset_url as a allowed parameter
  * Can now pass nics as a parameter. Will override networks

## 2012-06-06

  * Brand 'joyent-minimal' is now supported

## 2012-06-05

  * When creating a new VM you can now pass dataset_url
  * When creating a new VM you can now pass server_uuid

## 2012-06-04

  * VM actions now return a Job Response Object

## 2012-06-01

  * VM API endpoints are now named /vms instead of /machines
  * /machines is still aliased but deprecated

## 2012-05-28

  * Search VMs by tags

## 2012-05-23

  * 'networks' is a required parameter for POST /vms
  * Add sync=true parameter to GET /vms/uuid

## 2012-05-22

  * Add sync=true parameter to DELETE /vms/uuid
