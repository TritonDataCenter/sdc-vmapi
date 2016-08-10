/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
var backoff = require('backoff');
var bunyan = require('bunyan');
var events = require('events');
var restify = require('restify');
var util = require('util');
var verror = require('verror');

/*
 * MorayBucketsInitializer instances drive the process that sets up the moray
 * buckets that need to be present for VMAPI to function properly. They take an
 * instance of the "Moray" constructor and an object that represents the desired
 * configuration of moray buckets used by VMAPI as input.
 *
 * Once an instance of MorayBucketsInitializer has been created, its "start"
 * method can be called to actually start the process.
 *
 * If the process completes successfully, a 'done' event is emitted by a
 * MorayBucketsInitializer instance. If the process encounters an unrecoverable
 * error, it emits an 'error' event.
 */

/*
 * The MorayBucketsInitializer function is a constructor that can be used to
 * create instances of MorayBucketsInitializer. It derives from
 * events.EventEmitter.
 *
 * Its parameters are:
 *
 * - "options": an object with properties and values that can be used to tweak
 * the behavior of the initializer. The following properties are supported:
 *
 *   * "maxAttempts": the number of attempts before an 'error' event is emitted.
 *     Its default value is "undefined" and it causes the process to be retried
 *     indefinitely, unless a non-tranient error is encountered.
 */
function MorayBucketsInitializer(options) {
    assert.optionalObject(options, 'options');
    if (options) {
        assert.optionalNumber(options.maxAttempts, 'options.maxAttempts');
        this._maxAttempts = options.maxAttempts;

        assert.optionalObject(options.log, 'options.log');
        this._log = options.log;
    }

    if (!this._log) {
        this._log = new bunyan({
            name: 'moray-buckets-initializer',
            level: 'info',
            serializers: restify.bunyan.serializers
        });
    }
}

util.inherits(MorayBucketsInitializer, events.EventEmitter);

/*
 * The "start" method can be used to actually start the process of setting up
 * VMAPI's moray buckets.
 *
 * Its parameters are:
 *
 * * - "morayStorage": an instance of the Moray constructor use to actually
 * perform operations against the moray key/values store.
 *
 * - "morayBucketsConfig": an object that represents the configuration of the
 * buckets that need to be setup in moray for VMAPI to be able to function
 * properly.
 *
 * When the process completes successfully, the 'done' event is emitted on the
 * MorayBucketsInitializer instance.
 *
 * When the process encounters an error, it emits an 'error' event if the error
 * is considered to be unrecoverable. If the error is considered to be
 * recoverable, it restarts the process until it succeeds, or until the maximum
 * number of retries has been reached.
 *
 * If the maximum number of retries has been reached, the 'error' event is
 * emitted.
 *
 * Transient moray setup errors are considered to be recoverable and
 * non-transient errors (such as bad bucket configuration errors) are considered
 * to be unrecoverable.
 */
MorayBucketsInitializer.prototype.start =
    function start(morayStorage, morayBucketsConfig) {
    assert.object(morayStorage, 'morayStorage');
    assert.object(morayBucketsConfig, 'morayBucketsConfig');

    var self = this;

    var INITIAL_SETUP_BUCKET_BACKOFF_DELAY_MS = 10;
    var MAX_SETUP_BUCKET_BACKOFF_DELAY_MS = 5000;

    var setupMorayBucketsBackoff = backoff.exponential({
        initialDelay: INITIAL_SETUP_BUCKET_BACKOFF_DELAY_MS,
        maxDelay: MAX_SETUP_BUCKET_BACKOFF_DELAY_MS
    });

    if (self._maxAttempts !== undefined) {
        setupMorayBucketsBackoff.failAfter(self._maxAttempts);
    }

    function onBucketsSetup(bucketsSetupErr) {
        var errTransient = true;

        if (bucketsSetupErr) {
            errTransient =
                morayStorage.isBucketsSetupErrorTransient(bucketsSetupErr);
            if (!errTransient) {
                self._log.error({error: bucketsSetupErr},
                    'Non-transient error encountered, stopping buckets setup ' +
                        'backoff');
                setupMorayBucketsBackoff.reset();

                self.emit('error', new verror.VError({
                    cause: bucketsSetupErr
                }, 'Non transient error encountered when setting up moray ' +
                    'buckets'));
            } else {
                self._log.warn({error: bucketsSetupErr},
                    'Transient error encountered, backing off');
                setupMorayBucketsBackoff.backoff();
            }
        } else {
            self._log.info('Moray buckets initialization done!');
            setupMorayBucketsBackoff.reset();
            self.emit('done');
        }
    }

    setupMorayBucketsBackoff.on('ready', function onSetupBucketsBackoffReady() {
        morayStorage.setupBuckets(morayBucketsConfig, onBucketsSetup);
    });

    setupMorayBucketsBackoff.on('backoff',
        function onSetupBucketsBackoff(number, delay) {
            self._log.warn({
                number: number,
                delay: delay
            }, 'Moray buckets setup backed off');
        });

    setupMorayBucketsBackoff.on('fail', function onSetupBucketsFail() {
        self.emit('error', new Error('Maximum number of tries reached when ' +
            'initializing moray buckets'));
    });

    setupMorayBucketsBackoff.backoff();
};

module.exports = MorayBucketsInitializer;