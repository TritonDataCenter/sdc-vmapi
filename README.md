WHERE IS USER INTERFACE (GUI) ?
I NOT LIKE THESE CONSOLE THINGS!
IT IS NOT USability plean)
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

# Development

Typically VMAPI development is done by:

- making edits to a clone of sdc-vmapi.git on a Mac (likely Linux too, but
  that's untested) or a SmartOS development zone,

        git clone git@github.com:joyent/sdc-vmapi.git
        cd sdc-vmapi
        git submodule update --init   # not necessary first time
        vi

- building:

        make all
        make check

- syncing changes to a running SDC (typically a COAL running locally in VMWare)
  via:
        ./tools/rsync-to coal

- then testing changes in that SDC (e.g. COAL).
  See "Testing" below for running the test suite.


## Testing

To sync local changes to a running COAL and run the test suite there try:

    make test-coal

