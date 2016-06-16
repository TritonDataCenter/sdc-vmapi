// Copyright 2012 Mark Cavage, Inc.  All rights reserved.
// Copyright (c) 2016, Joyent, Inc.

// This is basically the user agent pre-route handler from
// https://github.com/restify/plugins with a bug fix that was submitted upstream
// at https://github.com/restify/plugins/pull/40. If and when
// https://github.com/restify/plugins/pull/40 is merged, the goal is to backport
// it to whatever restify branch VMAPI uses at that time and remove this local
// copy.

var assert = require('assert-plus');

/**
 * This basically exists for curl.  curl on HEAD requests usually
 * just sits there and hangs, unless you explicitly set
 * Connection:close.  And in general, you probably want to set
 * Connection: close to curl anyway.
 *
 * Also, because curl spits out an annoying message to stderr about
 * remaining bytes if content-length is set, this plugin also drops
 * the content-length header (some user agents handle it and want it,
 * curl does not).
 *
 * To be slightly more generic, the options block takes a user
 * agent regexp, however.
 * @public
 * @function userAgentConnection
 * @param    {Object} options an options object
 * @returns  {Function}
 */
function userAgentConnection(options) {
    var opts = options || {};
    assert.optionalObject(opts, 'options');
    assert.optionalObject(opts.userAgentRegExp, 'options.userAgentRegExp');

    var re = opts.userAgentRegExp;

    if (!re) {
        re = /^curl.+/;
    }

    function handleUserAgent(req, res, next) {
        var ua = req.headers['user-agent'];

        if (ua && re.test(ua)) {
            res.setHeader('Connection', 'close');

            if (req.method === 'HEAD') {
                res.once('header',
                    res.removeHeader.bind(res, 'content-length'));
            }
        }

        next();
    }

    return (handleUserAgent);
}

module.exports = userAgentConnection;
