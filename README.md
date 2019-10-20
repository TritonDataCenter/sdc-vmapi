<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright 2019 Joyent, Inc.
-->

# sdc-vmapi

This repository is part of the Joyent Triton project. See the [contribution
guidelines](https://github.com/joyent/triton/blob/master/CONTRIBUTING.md)
and general documentation at the main
[Triton project](https://github.com/joyent/triton) page.

VMAPI is an HTTP API server for managing VMs on a Triton installation.


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


# Testing

* Prerequisites:
    * Set up fabrics on the Triton deployment.
    * Ensure there are no existing NAT zones provisioned.
    * Execute `sdcadm post-setup dev-headnode-prov`.

* To sync local changes to a running COAL and run the test suite there use:

    make test-coal

* To run tests while logged into a running VMAPI instance:

    /opt/smartdc/vmapi/test/runtests
