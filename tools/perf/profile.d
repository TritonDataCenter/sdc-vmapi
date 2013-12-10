#!/usr/sbin/dtrace -s
#pragma D option quiet

/* arg2 is request id */
/* arg3 is method */
/* arg4 is url */
restify*:::route-start
{
    self->url = copyinstr(arg4);
    self->method = copyinstr(arg3);
    track[arg2] = timestamp;
}


/* arg1 is route name */
/* arg2 is request id */
restify*:::route-done
/self->url != NULL && self->method != NULL && track[arg2]/
{
    printf("%s %s %d %d %d %s\n", self->method, self->url, arg2, arg3, (timestamp - track[arg2]) / 1000000, copyinstr(arg0));
    track[arg2] = 0;
    self->url = 0;
}