#!/usr/sbin/dtrace -s
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * Taken from git@github.com:brendangregg/dtrace-cloud-tools.git
 *
 * node_slatency.d      Summarize node.js HTTP server latency.
 *
 * Requires the node DTrace provider, and a working version of the node
 * translator (/usr/lib/dtrace/node.d).
 *
 * 25-Jun-2013  Brendan Gregg   Created this (lost the originals).
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
