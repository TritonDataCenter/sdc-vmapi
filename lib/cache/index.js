/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

var redis = require('./redis');
var moray = require('./moray');

module.exports = {
	redis: redis,
	moray: moray
};
