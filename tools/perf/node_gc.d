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

