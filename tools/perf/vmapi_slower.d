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
 * vmapi_slower.d               Show VMAPI server requests slower than threshold.
 *
 * USAGE: vmapi_slower.d [min_ms]
 *    eg,
 *        vmapi_slower.d 10     # show requests slower than 10 ms
 *        vmapi_slower.d                # show all requests
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
    printf("%-20s %-6s %8s %6s %6s %6s %s\n", "TIME", "PID", "SERVER", "METHOD",
        "STATUS", "ms", "URL");
}

/*
 *                server_name, route_name, id, method, url, headers (json)
 * 'route-start': ['char *', 'char *', 'int', 'char *', 'char *', 'json'],
 */
restify*:::route-start
{
    this->server = copyinstr(arg0);
    this->method = copyinstr(arg3);
    url[pid, this->server] = copyinstr(arg4);
    ts[pid, this->server] = timestamp;
}

/*
 *                server_name, route_name, id, statusCode, headers (json)
 * ' route-done': ['char *', 'char *', 'int', 'int', 'json'],
 */
restify*:::route-done
{
    this->server = copyinstr(arg0);
    this->status = arg3;
    /* FALLTHRU */
}

restify*:::route-done
/(this->start = ts[pid, this->server]) &&
    (this->delta = timestamp - this->start) > min_ns/
{
    printf("%-20Y %-6d %8s %6s %6d %6d %s\n", walltimestamp, pid,
    this->server, this->method, this->status,
    this->delta / 1000000, url[pid, this->server]);
}

restify*:::route-done
/this->start/
{
    ts[pid, this->server] = 0;
    url[pid, this->server] = 0;
}
