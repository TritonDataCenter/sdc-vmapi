#!/usr/bin/bash
# -*- mode: shell-script; fill-column: 80; -*-
#
# Copyright (c) 2013 Joyent Inc., All rights reserved.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o xtrace

PATH=/opt/smartdc/vmapi/build/node/bin:/opt/local/bin:/opt/local/sbin:/usr/bin:/usr/sbin

echo "Updating SMF manifest"
$(/opt/local/bin/gsed -i"" -e "s/@@PREFIX@@/\/opt\/smartdc\/vmapi/g" /opt/smartdc/vmapi/smf/manifests/vmapi.xml)

echo "Importing vmapi.xml"
/usr/sbin/svccfg import /opt/smartdc/vmapi/smf/manifests/vmapi.xml

exit 0
