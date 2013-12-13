#!/usr/sbin/dtrace -s
/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * vmapi_cache_stats.d		Prints a message every time a heartbeat is being
 *                          invalidated and prints a summary of heartbeat
 *                          processing activity for the period of time this
 *                          script ran
 *
 * USAGE: vmapi_cache_stats.d
 *
 * Requires the node DTrace provider, and a working version of the node
 * translator (/usr/lib/dtrace/node.d).
 */

#pragma D option quiet
#pragma D option defaultargs
#pragma D option dynvarsize=8m
#pragma D option switchrate=10

dtrace:::BEGIN
{
	printf("Tracing VMAPI heartbeats being invalidated\n");
    printf("%-20s %-36s %-36s %6s %6s\n", "TIME", "SERVER", "VM UUID",
    	"NEW VM", "CNAPI");
}

/*
 *                			  server_uuid, vm_uuid, id, heartbeat (json)
 * 'heartbeat-process-start': ['char *', 'char *', 'int', 'json'],
 */
vmapi*:::heartbeat-process-start
{
	this->server = copyinstr(arg0);
	this->vm = copyinstr(arg1);
	ts[arg2] = timestamp;
}

/*
 *                         server_uuid, vm_uuid, id, new_machine, call_cnapi
 * 'heartbeat-process-invalidate': ['char *', 'char *', 'int', 'char *',
 *                                  'char *'],
 */
vmapi*:::heartbeat-process-invalidate
{
    printf("%-20Y %36s %36s %6s %6s\n", walltimestamp, this->server, this->vm,
        copyinstr(arg3), copyinstr(arg4));
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
    @["heartbeat processing time (ms)"] = quantize(this->delta);
}

vmapi*:::heartbeat-process-done
/this->start/
{
	ts[arg2] = 0;
}
