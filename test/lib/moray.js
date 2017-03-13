/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

var assert = require('assert-plus');
var jsprim = require('jsprim');

var changefeedTest = require('./changefeed');
var common = require('../common');
var MORAY = require('../../lib/apis/moray');

function createMorayClient() {
    var morayConfig = jsprim.deepCopy(common.config.moray);

    morayConfig.changefeedPublisher = changefeedTest.createNoopCfPublisher();

    var moray = new MORAY(morayConfig);
    return moray;
}

module.exports = {
    createMorayClient: createMorayClient
};