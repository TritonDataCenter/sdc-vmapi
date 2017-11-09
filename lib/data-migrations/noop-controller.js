/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * This module implements a mocked data migrations controller that immediately
 * emits an event signaling that all migrations completed successfully. It is
 * meant to be used when a VmapiApp instance needs to be created but we don't
 * really care about data migrations (e.g tests that do not test data migrations
 * specifically).
 */

var assert = require('assert-plus');
var EventEmitter = require('events');
var util = require('util');

function NoopDataMigrationsController() {
    EventEmitter.call(this);
}
util.inherits(NoopDataMigrationsController, EventEmitter);

NoopDataMigrationsController.prototype.start = function start() {
    this.emit('done');
};

NoopDataMigrationsController.prototype.getLatestCompletedMigrations =
function getLatestCompletedMigrations() {
    return {};
};

NoopDataMigrationsController.prototype.getLatestErrors =
function getLatestErrors() {
    return undefined;
};

NoopDataMigrationsController.prototype.getLatestCompletedMigrationForModel =
function getLatestCompletedMigrationForModel(modelName) {
    assert.string(modelName, 'modelName');

    return undefined;
};

module.exports = NoopDataMigrationsController;