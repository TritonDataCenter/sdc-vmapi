/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Moray cache.
 */

var assert = require('assert-plus');


/*
 * Moray cache client constructor
 */
function Moray(options) {
    assert.object(options, 'moray-cache options');
    assert.object(options.client, 'moray-cache options.client');

    this.options = options;
    this.client = options.client;
}


/*
 * For a Moray cache just return right away since the moray connection is being
 * setup by the moray client separately
 */
Moray.prototype.connect = function (cb) {
    return cb(null);
};


/*
 * Returns client.connected
 */
Moray.prototype.connected = function () {
    return this.client && this.client.connected;
};


/*
 * Gets a list of VMs that live on a server
 */
Moray.prototype.getVmsForServer = function (server, callback) {
    return this.client.getVmsForServer(server, callback);
};



/*
 * Sets a list of VMs that live on a server
 */
Moray.prototype.setVmsForServer = function (server, hash, callback) {
    return this.client.setVmsForServer(server, hash, callback);
};



/*
 * Gets the status stamp for a VM. The stamp format has the following form:
 *
 * $zone_state:$last_modified
 *
 */
Moray.prototype.getState = function (uuid, callback) {
    return this.client.getState(uuid, callback);
};



/*
 * Sets the state stamp for a VM. On a moray cache this is not needed because
 * we already persisted the VM state with either updateStateOnMoray or
 * updateVmOnMoray. In order to not break the interface we just call cb();
 */
Moray.prototype.setState = function (uuid, hb, server, callback) {
    return callback(null);
};



/*
 * Deletes the state stamp for a VM. Called after markAsDestroyed. On a moray
 * cache this is not needed because we already persisted the VM state as
 * destroyed with markAsDestroyed. In order to not break the interface we just
 * call cb();
 */
Moray.prototype.delState = function (uuid, callback) {
    return callback(null);
};



module.exports = Moray;
