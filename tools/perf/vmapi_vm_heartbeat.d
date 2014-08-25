#!/usr/sbin/dtrace -s
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * vmapi_vm_heartbeat.d		Sample script to demostrate usage of VMAPI heartbeat
 *							DTrace probes. This script will show the latency
 *							when processing every heartbeat seen for a VM
 *
 * USAGE: vmapi_vm_heartbeat.d [vm_uuid]
 *    eg,
 *        vmapi_vm_heartbeat.d 930896af-bf8c-48d4-885c-6573a94b1853
 *
 * Requires the node DTrace provider, and a working version of the node
 * translator (/usr/lib/dtrace/node.d).
 */

#pragma D option quiet
#pragma D option defaultargs
#pragma D option dynvarsize=8m
#pragma D option switchrate=10

dtrace:::BEGIN
/$1 == 0/
{
	printf("USAGE: %s vm_uuid\n\n", $$0);
	printf("\teg: %s 1d8b9d98-987a-4070-9c20-e7189acce06e\n", $$0);
	exit(1);
}

dtrace:::BEGIN
{
	printf("Tracing VMAPI heartbeats for VM %s\n", $$1);
    printf("%-20s %-36s %-36s %6s %12s %6s %s\n", "TIME", "SERVER", "OWNER",
    	"RAM", "STATE", "QUOTA", "ms");
}

/*
 *                			  server_uuid, vm_uuid, id, heartbeat (json)
 * 'heartbeat-process-start': ['char *', 'char *', 'int', 'json'],
 */
vmapi*:::heartbeat-process-start
/$1 == copyinstr(arg1)/
{
	this->server = copyinstr(arg0);
	this->vm = copyinstr(arg1);
	this->hb = copyinstr(arg3);
	ts[arg2] = timestamp;
}

/*
 *                			 server_uuid, vm_uuid, int
 * 'heartbeat-process-done': ['char *', 'char *', 'int'],
 */
vmapi*:::heartbeat-process-done
/this->vm == copyinstr(arg1) && ts[arg2]/
{
	this->start = ts[arg2];
	this->delta = (timestamp - this->start) / 1000000;
    	printf("%-20Y %36s %36s %6s %12s %6s %d\n", walltimestamp, this->server,
    		json(this->hb, "owner_uuid"),
    		json(this->hb, "max_physical_memory"), json(this->hb, "state"),
    		json(this->hb, "quota"), this->delta);
}

vmapi*:::heartbeat-process-done
/this->start/
{
	ts[arg2] = 0;
}
