#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

set -o xtrace
set -o errexit

DIR=/opt/smartdc/vmapi

if [[ -z $DNS_DOMAIN ]]; then
    echo "\$DNS_DOMAIN variable is not set, cannot start VMAPI server"
    exit 1
fi

function subfile()
{
  IN=$1
  OUT=$2
  sed -e "s/@@DNS_DOMAIN@@/$DNS_DOMAIN/g" $IN > $OUT
}

echo 'Generating VMAPI config file.'
subfile "$DIR/config.docker.json" "$DIR/config.json"

/usr/bin/node $DIR/server.js
