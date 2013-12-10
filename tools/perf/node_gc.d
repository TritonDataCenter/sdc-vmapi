#!/usr/sbin/dtrace -s
/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * Taken from git@github.com:brendangregg/dtrace-cloud-tools.git
 */

#pragma D option quiet

dtrace:::BEGIN
{
	trace("Tracing node.js GC... Ctrl-C for summary.\n");
}

node*:::gc-start
{
        self->ts = timestamp;
}

node*:::gc-done
/self->ts/
{
	this->delta = (timestamp - self->ts) / 1000000;
        printf("%Y PID %-5d GC %d ms\n", walltimestamp, pid, this->delta);
	@["GC (ms) summary:"] = quantize(this->delta);
        self->ts = 0;
}

