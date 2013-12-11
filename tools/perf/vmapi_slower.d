#!/usr/sbin/dtrace -s
/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * vmapi_slower.d		Show VMAPI server requests slower than threshold.
 *
 * USAGE: vmapi_slower.d [min_ms]
 *    eg,
 *        vmapi_slower.d 10 	# show requests slower than 10 ms
 *        vmapi_slower.d 		# show all requests
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
	min_ns = $1 * 1000000;
	printf("Tracing VMAPI server requests slower than %d ms\n", $1);
        printf("%-20s %-6s %6s %s\n", "TIME", "PID", "ms", "URL");
}

node*:::http-server-request
{
	this->fd = args[1]->fd;
	url[pid, this->fd] = args[0]->url;
	ts[pid, this->fd] = timestamp;
}

node*:::http-server-response
{
	this->fd = args[0]->fd;
	/* FALLTHRU */
}

node*:::http-server-response
/(this->start = ts[pid, this->fd]) &&
    (this->delta = timestamp - this->start) > min_ns/
{
        printf("%-20Y %-6d %6d %s\n", walltimestamp, pid,
	    this->delta / 1000000, url[pid, this->fd]);
}

node*:::http-server-response
/this->start/
{
	ts[pid, this->fd] = 0;
	url[pid, this->fd] = 0;
}
