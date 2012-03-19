# Zones API

 * Repository: git clone git@git.joyent.com:zapi.git
 * Browsing: <https://mo.joyent.com/zapi>
 * Docs: <https://mo.joyent.com/docs/zapi>
 * Who: Andres Rodriguez
 * Tickets/bugs: <https://devhub.joyent.com/jira/browse/ZAPI>

# Introduction

Zones API allows clients to get information about machines on a datacenter by using an HTTP API. ZAPI offers the following features:

 * Search machines by specific criteria such as ram, owner, tags, server, dataset, etc.
 * Get information about a single machine
 * Create new machines
 * Perform actions on an existing machine such as start, stop, reboot and resize
 * Update machines
 * Destroy machines


# Design & Requirements

* Node.js restify HTTP server
* UFDS is the remote datastore for ZAPI. ZAPI does not have persistency and all zones data living on UFDS should be considered a cache
* A heartbeater AMQP client listens for zone heartbeats so ZAPI can return status information for zones
 * ZAPI is only concerned for exposing zones information to users the same way CNAPI does for compute nodes
 * There is one ZAPI instance per datacenter
 * ZAPI is stateless: when any machine action is called (create, destroy, reboot, etc) the message is passed through a workflow API instance that takes care of it
 * ZAPI should be as dumb as possible. Contrary to MAPI, ZAPI does not have complicated logic that prevents users to call actions on zones (and even creating zones). Much of the required logic for this is moved to the corresponding workflow and other participant APIs
 * ...

# Development and Local Installation

    # Get the source and build.
    git clone git@git.joyent.com:zapi.git
    cd zapi/
    make all

    # Setup config.
    # Note that there is a dependency on a headnode instance with a running UFDS
    cp config.mac.json config.json
    vi config.json

    # node server.js


# Testing

    make test

