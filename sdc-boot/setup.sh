#!/usr/bin/bash
#
# Copyright (c) 2011 Joyent Inc., All rights reserved.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o xtrace

PATH=/opt/local/bin:/opt/local/sbin:/usr/bin:/usr/sbin

role=vmapi
app_name=$role

CONFIG_AGENT_LOCAL_MANIFESTS_DIRS=/opt/smartdc/$role

# Include common utility functions (then run the boilerplate)
source /opt/smartdc/sdc-boot/lib/util.sh
sdc_common_setup

# Cookie to identify this as a SmartDC zone and its role
mkdir -p /var/smartdc/vmapi

# Install VMAPI
mkdir -p /opt/smartdc/vmapi
chown -R nobody:nobody /opt/smartdc/vmapi

# Add build/node/bin and node_modules/.bin to PATH
echo "" >>/root/.profile
echo "export PATH=\$PATH:/opt/smartdc/vmapi/build/node/bin:/opt/smartdc/vmapi/node_modules/.bin" >>/root/.profile

# Install Amon monitor and probes for VMAPI.
TRACE=1 /opt/smartdc/vmapi/bin/vmapi-amon-install

echo "Adding log rotation"
logadm -w vmapi -C 48 -s 100m -p 1h \
    /var/svc/log/smartdc-site-vmapi:default.log

# All done, run boilerplate end-of-setup
sdc_setup_complete

exit 0
