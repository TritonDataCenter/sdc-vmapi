<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# VMs API

 * Repository: git clone git@git.joyent.com:vmapi.git
 * Browsing: <https://mo.joyent.com/vmapi>
 * Docs: <https://mo.joyent.com/docs/vmapi>
 * Who: Andres Rodriguez
 * Tickets/bugs: <https://devhub.joyent.com/jira/browse/VMAPI>

# Introduction

VMs API allows clients to get information about machines on a datacenter by using an HTTP API. VMAPI offers the following features:

 * Search machines by specific criteria such as ram, owner, tags, server, dataset, etc.
 * Get information about a single machine
 * Create new machines
 * Perform actions on an existing machine such as start, stop, reboot and resize
 * Update machines
 * Destroy machines


# Design & Requirements

* Node.js restify HTTP server
* UFDS is the remote datastore for VMAPI. VMAPI does not have persistency and all zones data living on UFDS should be considered a cache
* A heartbeater AMQP client listens for zone heartbeats so VMAPI can return status information for zones
 * VMAPI is only concerned for exposing zones information to users the same way CNAPI does for compute nodes
 * There is one VMAPI instance per datacenter
 * VMAPI is stateless: when any machine action is called (create, destroy, reboot, etc) the message is passed through a workflow API instance that takes care of it
 * VMAPI should be as dumb as possible. Contrary to MAPI, VMAPI does not have complicated logic that prevents users to call actions on zones (and even creating zones). Much of the required logic for this is moved to the corresponding workflow and other participant APIs
 * ...

# Development and Local Installation

    # Get the source and build.
    git clone git@git.joyent.com:vmapi.git
    cd vmapi/
    make all

    # Setup config.
    # Note that there is a dependency on a headnode instance with a running UFDS
    cp config.mac.json config.json
    vi config.json

    # node server.js


# Testing

    make test

