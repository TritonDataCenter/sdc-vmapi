#!/usr/sbin/dtrace -s
/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * Taken from git@github.com:brendangregg/dtrace-cloud-tools.git
 *
 * node_slatency.d	Summarize node.js HTTP server latency.
 *
 * Requires the node DTrace provider, and a working version of the node
 * translator (/usr/lib/dtrace/node.d).
 *
 * 25-Jun-2013	Brendan Gregg	Created this (lost the originals).
 */

node*:::http-server-request
{
	ts[pid, args[1]->fd] = timestamp;
}

node*:::http-server-response
/this->start = ts[pid, args[0]->fd]/
{
	@["ns"] = quantize(timestamp - this->start);
	ts[pid, args[0]->fd] = 0;
}
