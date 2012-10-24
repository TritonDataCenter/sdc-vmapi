/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */


var EventEmitter = require('events').EventEmitter;
var sprintf = require('sprintf').sprintf;
var assert = require('assert');
var restify = require('restify');
var util = require('util');

var common = require('./../common');
var moray = require('moray');

var PARAM_FILTER = '(%s=%s)';


/*
 * Basically the VMs table
 */
var VMS_BUCKET_NAME = 'vmapi_vms';
var VMS_BUCKET = {
	index: {
		uuid: { type: 'string', unique: true},
		owner_uuid: { type: 'string' },
		image_uuid: { type: 'string' },
		billing_id: { type: 'string' },
		server_uuid: { type: 'string' },
		brand: { type: 'string' },
		state: { type: 'string' },
		alias: { type: 'string' },
		max_physical_memory: { type: 'number' },
		create_timestamp: { type: 'number' }
	}
}



/*
 * Moray constructor
 */
function Moray(options) {
    EventEmitter.call(this);
    this.log = options.log;
    this.options = options;
    this.connected = false;

    this._connect();
}

util.inherits(Moray, EventEmitter);



/*
 * Attempts to connect to moray, retrying until connection is established
 * emits 'ready' event when connection to moray is ready and buckets have been
 * initialized
 */
Moray.prototype._connect = function () {
    this.log.info('Connecting to moray...');
    attemptConnect.call(this);
};



function attemptConnect() {
    var self = this;
    var timeout = null;
	this.connection = moray.createClient(this.options)

    function onReady() {
        clearTimeout(timeout);
        timeout = null;
        self.connected = true;
        self.log.info('Connected to moray...');

        self._setupBuckets(function(err) {
        	assert.ifError(err);
        	self.log.info('Buckets have been loaded');
        	self.emit('ready');
        });
    }

    function onError(err) {
        self.log.error('Error connecting to moray');
        self.log.info('Re-attempting connection...');

        self.connection.removeAllListeners();
        self.connected = false;
        self.connection = null;

        if (!timeout) {
            attemptConnect.call(self);
        }
    }

    function timeoutCallback() {
        attemptConnect.call(self);
    }

    this.connection.on('connect', onReady);
    this.connection.on('error', onError);
    timeout = setTimeout(timeoutCallback, 10000);
}



/*
 * Gets a VM object from moray. uuid is required param and owner_uuid is
 * optional
 */
Moray.prototype.getVm = function(params, cb) {
    var uuid = params.uuid;
    var owner = params['owner_uuid'];
    var filter = '';

    if (!common.validUUID(uuid)) {
       	cb(new restify.InvalidArgumentError('VM UUID is not a valid UUID'));
       	return;
	}

    filter += sprintf(PARAM_FILTER, 'uuid', uuid);

    if (owner) {
        if (!common.validUUID(owner)) {
        	/*JSSTYLED*/
            cb(new restify.InvalidArgumentError('Owner UUID is not a valid UUID'));
            return;
        }

        filter += sprintf(PARAM_FILTER, 'owner_uuid', owner);
        filter = '(&' + filter + ')';
    }

    var vm;
	var req = this.connection.findObjects(VMS_BUCKET_NAME, filter);

	req.once('error', function (err) {
		cb(err);
	});

	// For getVm we want the first result (and there should only be one result)
	req.once('record', function (object) {
		vm = object.value;
	});

	req.once('end', function () {
		cb(null, vm);
	});
};



/*
 * Gets VMs from a list of UUIDs
 */
Moray.prototype.getVms = function(uuids, cb) {
    var filter = '';
    var i;

    for (i = 0; i < uuids.length; i++) {
        filter += sprintf(PARAM_FILTER, 'uuid', uuids[i]);
    }

    filter = '(|' + filter + ')';
    var vms = [];
    var req = this.connection.findObjects(VMS_BUCKET_NAME, filter);

    req.once('error', function (err) {
        cb(err);
    });

    req.on('record', function (object) {
        vms.push(common.translateVm(object.value, true));
    });

    req.once('end', function () {
        cb(null, vms);
    });
};



/*
 * List VMs
 */
Moray.prototype.listVms = function(params, cb) {
	var filter = [];

    if (params.uuid) {
    	if (!common.validUUID(params.uuid)) {
	       	cb(new restify.InvalidArgumentError('VM UUID is not a valid UUID'));
	       	return;
       	}

       	filter.push(sprintf(PARAM_FILTER, 'uuid', params.uuid));
	}

    if (params['owner_uuid']) {
    	if (!common.validUUID(params['owner_uuid'])) {
    		/*JSSTYLED*/
	       	cb(new restify.InvalidArgumentError('Owner UUID is not a valid UUID'));
	       	return;
       	}

       	filter.push(sprintf(PARAM_FILTER, 'owner_uuid', params['owner_uuid']));
	}

    if (params['image_uuid']) {
		filter.push(sprintf(PARAM_FILTER, 'image_uuid', params['image_uuid']));
   	}

    if (params['server_uuid']) {
    	/*JSSTYLED*/
		filter.push(sprintf(PARAM_FILTER, 'server_uuid', params['server_uuid']));
   	}

    if (params['billing_id']) {
    	filter.push(sprintf(PARAM_FILTER, 'billing_id', params['billing_id']));
   	}

    if (params['package_name']) {
    	/*JSSTYLED*/
    	filter.push(sprintf(PARAM_FILTER, 'package_name', params['package_name']));
   	}

    if (params['package_version']) {
    	/*JSSTYLED*/
    	filter.push(sprintf(PARAM_FILTER, 'package_version', params['package_version']));
   	}

    if (params.brand) {
		filter.push(sprintf(PARAM_FILTER, 'brand', params.brand));
   	}

    if (params.alias) {
		filter.push(sprintf(PARAM_FILTER, 'alias', params.alias));
   	}

    if (params.state) {
        if (params.state == 'active') {
			filter.push('(!(state=destroyed))');
        } else {
			filter.push(sprintf(PARAM_FILTER, 'state', params.state));
        }
   	}

    if (params.ram || params['max_physical_memory']) {
    	var value = params.ram || params['max_physical_memory'];
		filter.push(sprintf(PARAM_FILTER, 'max_physical_memory', value));
   	}

   	var string = filter.join('');

	if (filter.length == 0) {
		string = '(uuid=*)';
   	} else if (filter.length > 1) {
   		string = '(&' + string + ')';
   	}

   	var vms = [];
	var req = this.connection.findObjects(VMS_BUCKET_NAME, string);

	req.once('error', function (err) {
		cb(err);
	});

	req.on('record', function (object) {
		vms.push(common.translateVm(object.value, true));
	});

	req.once('end', function () {
		cb(null, vms);
	});
};



/*
 * Puts a VM. If it doesn't exist it gets created, if it does exist it gets
 * updated. We no longer need to execute partial updates
 */
Moray.prototype.putVm = function(uuid, vm, cb) {
	var object = this._toMorayVm(vm);
	this.connection.putObject(VMS_BUCKET_NAME, uuid, object, cb);
};



Moray.prototype.markAsDestroyed = function (vm, callback) {
    var self = this;

    vm.state = 'destroyed';
    vm.zone_state = 'destroyed';
    vm.destroyed = new Date();

    this.putVm(vm.uuid, vm, function (err) {
        if (err) {
            callback(err);
        } else {
            callback(null);
        }
    });
};



/*
 * Sets up the VM buckets. For now a single vms buckets is used
 */
Moray.prototype._setupBuckets = function(cb) {
	var self = this;
	this._getBucket(VMS_BUCKET_NAME, onBucket);

	function onBucket(err, bucket) {
		if (err) {
			if (err.name == 'BucketNotFoundError') {
				self._createBucket(VMS_BUCKET_NAME, VMS_BUCKET, onCreateBucket);
			} else {
				cb(err);
			}
		} else {
			cb(null);
		}
	}

	function onCreateBucket(err) {
		cb(err);
	}
};



/*
 * Gets a bucket
 */
Moray.prototype._getBucket = function(name, cb) {
	this.connection.getBucket(name, cb);
};



/*
 * Creates a bucket
 */
Moray.prototype._createBucket = function(name, config, cb) {
	this.connection.createBucket(name, config, cb);
};



/*
 * Converts to a valid moray VM object
 */
 Moray.prototype._toMorayVm = function(vm) {
    var copy = common.clone(vm);

    if (copy.nics) {
        copy.nics = JSON.stringify(copy.nics);
    }

    var timestamps = ['create_timestamp', 'last_modified', 'destroyed' ];
    timestamps.forEach(function (key) {
    	/*JSSTYLED*/
    	var isDate = (typeof (copy[key]) == 'object' && copy[key].getMonth != undefined);

        if (typeof (copy[key]) == 'string') {
            copy[key] = new Date(copy[key]).getTime();
        } else if (isDate) {
            copy[key] = copy[key].getTime();
        }
    });

    if (copy.tags) {
        var tags = common.objectToKeyValue(copy.tags);
        copy.tags = JSON.stringify(tags);
    }

    if (copy.internal_metadata) {
        copy.internal_metadata = JSON.stringify(copy.internal_metadata);
    }

    if (copy.customer_metadata) {
        copy.customer_metadata = JSON.stringify(copy.customer_metadata);
    }

    return copy;
}


module.exports = Moray;
