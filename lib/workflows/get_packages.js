/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */

// This is not really needed, but javascriptlint will complain otherwise:
var sdcclients = require('sdc-clients');

var workflow = module.exports = {
  name: 'Get packages from UFDS',
  chain: [ {
    name: 'Get packages',
    timeout: 30,
    retry: 1,
    body: function (job, cb) {
      if (!job.params.ufdsUrl || !job.params.ufdsDn || !job.params.ufdsPassword) {
        return cb('No UFDS parameters provided');
      }

      var options = {
        "url": job.params.ufdsUrl,
        "bindDN": job.params.ufdsDn,
        "bindPassword": job.params.ufdsPassword
      }

      var UFDS = sdcclients.UFDS;
      var ufds = new UFDS(options);
      var baseDn = "ou=packages, o=smartdc";

      var options = {
        scope: 'sub',
        filter: '(&(objectclass=sdcpackage))'
      };

      ufds.search(baseDn, options, function (err, items) {
        if (err)
          return cb(err);

        job.packages = items;
        return cb(null, "Got packages!");
      });
    }
  },{
    name: 'Read packages',
    timeout: 30,
    retry: 1,
    body: function (job, cb) {
      if (!job.packages)
        return cb('Why no packages in the job?');

      return cb(null, job.packages[0].urn);
    }
  }],
  timeout: 180,
  onerror: [ {
    name: 'On error getting packages',
    body: function (job, cb) {
      return cb("Error getting packages");
    }
  }]
};