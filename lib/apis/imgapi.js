/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var sdc = require('sdc-clients');


/*
 * IMGAPI Constructor
 */
function Imgapi(options) {
    this.log = options.log;
    this.client = new sdc.IMGAPI({ url: options.url, log: options.log });
}



/*
 * Get Image
 */
Imgapi.prototype.getImage = function (uuid, callback) {
    this.client.getImage(uuid, callback);
};


module.exports = Imgapi;
