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
 * vmapi_latency_aggregation.d		Show VMAPI server requests slower than threshold.
 *
 * USAGE: vmapi_latency_aggregation.d [min_ms]
 *    eg,
 *        vmapi_latency_aggregation.d 1 	# print aggregation every 5 secs
 *        vmapi_latency_aggregation.d 		# only print at the end
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
	printf("Tracing VMAPI server requests aggregation\n");
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
    (this->delta = timestamp - this->start)/
{
	this->route_name = strjoin(strjoin(this->method, " "),
		url[pid, this->server]);
	@latency[this->route_name] = avg(this->delta / 1000000);
	@ntimes[this->route_name] = count();
}

restify*:::route-done
/this->start/
{
	ts[pid, this->server] = 0;
	url[pid, this->server] = 0;
}

/* Is there a way to print these two aggregations together? */
profile:::tick-5sec/$1 == 1/
{
	printf("\n  %6s %s\n", "ms", "ROUTE");
	printa("  %@6d %s\n", @latency);
	trunc(@latency);

	printf("\n  %6s %s\n", "NTIMES", "ROUTE");
	printa("  %@6d %s\n", @ntimes);
	trunc(@ntimes);
}

dtrace:::END
{
	printf("\n  %6s %s\n", "ms", "ROUTE");
	printa("  %@6d %s\n", @latency);
	trunc(@latency);

	printf("\n  %6s %s\n", "NTIMES", "ROUTE");
	printa("  %@6d %s\n", @ntimes);
	trunc(@ntimes);
}