<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# sdc-vmapi

This repository is part of the Joyent SmartDataCenter project (SDC).  For
contribution guidelines, issues, and general documentation, visit the main
[SDC](http://github.com/joyent/sdc) project page.

VMAPI is an HTTP API server for managing VMs on an SDC installation.


# Features

* Search for VMs by specific criteria such as ram, owner, tags, etc.
* Get information about a single VM
* Create VMs
* Perform actions on an existing VM such as start, stop, reboot, update, modify NICs, destroy, etc.

# Development and Local Installation

    # Get the source and build.
    git clone git@github.com:joyent/sdc-vmapi.git
    cd sdc-vmapi/
    make all

    # Rsync your local copy to a running SDC headnode
    ./tools/rsync-to <headnode-ip>

    # Run the VMAPI test suite
    ssh <headnode-ip>
    [root@headnode ~]# touch /lib/sdc/.sdc-test-no-production-data
    [root@headnode ~]# /zones/`vmadm lookup -1 \
        alias=vmapi0`/root/opt/smartdc/vmapi/test/runtests

