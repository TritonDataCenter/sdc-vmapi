/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * A brief overview of this source file: what is its purpose.
 */


var sdc = require('sdc-clients');


/*
 * IMGAPI Constructor
 */
function Imgapi(options) {
    this.log = options.log;
    this.client = new sdc.IMGAPI({
        url: options.url,
        log: options.log,
        agent: options.agent
    });
}



/*
 * Get Image
 */
Imgapi.prototype.getImage = function (uuid, callback) {
    this.client.getImage(uuid, callback);
};


module.exports = Imgapi;
