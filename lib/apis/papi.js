/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var sdc = require('sdc-clients');


/*
 * PAPI Constructor
 */
function Papi(options) {
    this.log = options.log;
    this.client = sdc.PAPI({ url: options.url, log: options.log });
}



/*
 * Get Package
 */
Papi.prototype.getPackage = function (uuid, callback) {
    this.client.get(uuid, {}, callback);
};


module.exports = Papi;
