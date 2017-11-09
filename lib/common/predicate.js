/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * Taken from ca-pred.js and adapted to print an ldap compatible query from a
 * predicate object
 */

var assert = require('assert-plus');
var krill = require('krill');
var util = require('util');

var format = util.format;

/*
 * A mapping from a predicate key to the type specific parsing routine.  Any
 * change to the set of possible initial keys must update these data structures
 * as well as predEvaluate().
 */
var parseFuncs = {
    lt: predValidateRel,
    le: predValidateRel,
    gt: predValidateRel,
    ge: predValidateRel,
    eq: predValidateRel,
    ne: predValidateRel,
    and: predValidateLog,
    or: predValidateLog
};

/*
 * A mapping to the operator specific printing routine.
 */
var ldapPrintFuncs = {
    lt: ldapPrintRel,
    le: ldapPrintRel,
    gt: ldapPrintRel,
    ge: ldapPrintRel,
    eq: ldapPrintRel,
    ne: ldapPrintRel,
    and: ldapPrintLog,
    or: ldapPrintLog
};

/*
 * The operator specific string to use while printing
 */
var printStrings = {
    lt: '<',
    le: '<=',
    gt: '>',
    ge: '>=',
    eq: '=',
    ne: '=',
    and: '&',
    or: '|'
};

/*
 * Gets the key for the given predicate
 *
 * Input:
 *  - pred: The predicate to get the key for
 * Output:
 *  - returns the key for the specified predicate object
 */
function predGetKey(pred)
{
    var key, keysFound = 0;

    for (var val in pred) {
        keysFound++;
        key = val;
    }

    if (keysFound > 1)
        throw (new Error(format('found too many keys: %d. expected one',
            keysFound)));

    if (keysFound < 1)
        throw (new Error('predicate is missing a key'));

    return (key);
}

/*
 * Validates that the predicate has a valid format for relational predicates.
 * That means that it fits the format:
 * { key: [ field, constant ] }
 *
 * Input:
 *  - pred: The predicate
 *  - key: The key that we're interested in
 *
 * On return the following points have been validated:
 *  - That the key points to a two element array
 *  - That the first field is a valid type
 */
function predValidateRel(pred, key)
{
    var field, constant;

    if (!pred[key])
        throw (new Error(format('predicate is missing key %j', key)));

    if (!(pred[key] instanceof Array))
        throw (new Error('predicate key does not point to an array'));

    if (pred[key].length != 2)
        throw (new Error(format('predicate key ' +
            'does not point to an array of two elements: found %d ' +
            'elements', pred[key].length)));

    field = pred[key][0];
    constant = pred[key][1];

    if (typeof (field) != 'string')
        throw (new Error(format('predicate field is not a string: ' +
            'got %j.', field)));

    if (typeof (constant) != 'number' && typeof (constant) != 'string' &&
        typeof (constant) != 'boolean')
        throw (new Error(format('predicate constant is not a constant: ' +
            'got %j.', constant)));
}

/*
 * Validates that the logical expression has a valid format. This means that it
 * is of the format:
 * { key: [ obj, obj,... ] }
 *
 * Input:
 *  - pred: The current predicate
 *  - key: The key that we're interested in
 *
 * On Return the following points have been validated:
 *  - The key points to an array of at least length two
 *  - Every object in the array is a valid predicate or logical expression
 */
function predValidateLog(pred, key)
{
    var ii;

    if (!pred[key])
        throw (new Error(format('logical expr is ' +
            'missing key %j', key)));

    if (!(pred[key] instanceof Array))
        throw (new Error(format('logical expr key does not point to ' +
            'an array')));

    if (pred[key].length < 2)
        throw (new Error(format('logical expr ' +
            'key "%s" does not contain enough elements: found %d, ' +
            'expected at least two', key, pred[key].length)));

    for (ii = 0; ii < pred[key].length; ii++)
        predValidateSyntax(pred[key][ii]);
}

/*
 * This is the entry point for validating and parsing any given predicate. This
 * will be called when beginning to parse any specific predicate.
 *
 * Input:
 *  - pred: The predicate that we want to validate
 *
 * Output: None on success, an exception is thrown on error.
 */
function predValidateSyntax(pred)
{
    var key;

    if (!(pred instanceof Object))
        throw (new Error('predicate must be an object'));

    key = predGetKey(pred);
    if (!(key in parseFuncs))
        throw (new Error(format('invalid key: %s', key)));

    parseFuncs[key](pred, key);
}

exports.predValidateSyntax = predValidateSyntax;

/*
 * Prints out the value of a relational predicate.
 * This should print as:
 * <field> <operator> <constant>
 *
 * Input:
 *  - pred: The predicate to print
 *  - key: The key for the predicate
 *
 * Output:
 *  - Returns the ldap query string representation of the specified predicate.
 */
function ldapPrintRel(pred, key) {
    var field = pred[key][0];
    var string;

    switch (field) {
        case 'ram':
            string = printKeyValue(key, 'max_physical_memory', pred[key][1]);
            break;
        default:
            if (typeof (field) === 'string' &&
                field.match(/^tag\.(.*)$/)) {
                string = printTags(field, pred[key][1]);
            } else if (typeof (field) === 'string' &&
                field.match(/^internal_metadata\.(.*)$/)) {
                string = printInternalMetadata(field, pred[key][1]);
            } else {
                string = printKeyValue(key, field, pred[key][1]);
            }
            break;
    }

    // The 'ne' operation on LDAP is not "k!=v" but "!(k=v)" so we have this
    // extra function take this 'special' operation into account
    function postProcessRel(str) {
        if (key !== 'ne') {
            return str;
        }
        return '!(' + str + ')';
    }

    return postProcessRel(string);
}

function printTags(field, value) {
    var match = field.match(/tag\.(.*)/);
    var tagKey = match[1].replace(/-/g, '%2D');
    var tagString;

    // Numbers have to be backwards compatible if VMs with numbers as
    // key values already exist
    if (typeof (value) === 'boolean' || value === 'true' || value === 'false') {
        var bool = '*-' + tagKey + '=' + '%b{' + value + '}' + '-*';
        tagString = '*-' + tagKey + '=' + value + '-*';
        return format('|(tags=%s)(tags=%s)', bool, tagString);

    } else if (!isNaN(Number(value))) {
        var num = '*-' + tagKey + '=' + '%n{' + value + '}' + '-*';
        tagString = '*-' + tagKey + '=' + value + '-*';
        return format('|(tags=%s)(tags=%s)', num, tagString);

    } else {
        value = value.replace(/-/g, '%2D');
        tagString = '*-' + tagKey + '=' + value + '-*';
        return format('tags=%s', tagString);
    }
}

function printInternalMetadata(field, value) {
    assert.string(field, 'field');
    assert.string(value, 'value');

    var match = field.match(/internal_metadata\.(.*)/);
    var metadataKey = match[1];

    return format('internal_metadata_search_array=%s',
        metadataKey + '=' + value);
}

function printKeyValue(key, k, v) {
    return k + printStrings[key] + v;
}


/*
 * Prints out the value of a logical expression.
 * This should print as:
 * <operator>(<predicate>)(<predicate>)...
 *
 *
 * Inputs:
 *  - pred: The logical expression to print
 *  - key: The key for the object in the logical expression
 *
 * Output:
 *  - Returns the string representation of the specified predicate.
 */
function ldapPrintLog(pred, key) {
    var elts = pred[key].map(function (x) {
        return ('(' + ldapPrintGen(x) + ')');
    });

    return (printStrings[key] + elts.join(''));
}

/*
 * This is the generic entry point to begin parsing an individual predicate.
 * This is responsible for determining the key and dispatching to the correct
 * function.
 *
 * Inputs:
 *  - pred: The predicate to be printed
 *
 * Output:
 *  - Returns the ldap query string representation of the specified predicate.
 */
function ldapPrintGen(pred)
{
    var key;
    var keysFound = 0;

    /* Let's just do a bit of extra sanity checking, can't hurt */
    for (var val in pred) {
        key = val;
        keysFound++;
    }

    if (keysFound != 1)
        assert.ok(false, util.format('Expected only ' +
            'one key for the specified predicate. Found %d. Looking ' +
            'at predicate %j', keysFound, pred));

    if (!ldapPrintFuncs[key])
        assert.ok(false, util.format('Missing print ' +
            'function for key %s. Looking at predicate %j', key,
            pred));

    return (ldapPrintFuncs[key](pred, key));
}

/*
 * Prints the ldap query form of a predicate.
 *
 * Input:
 *  - pred: A predicate that has already been validated by predValidateSyntax
 *
 * Output:
 *  - Returns the ldap query string representation of the specified predicate.
 */
function toLdapQuery(pred)
{
    return ('(' + ldapPrintGen(pred) + ')');
}

exports.toLdapQuery = toLdapQuery;

/*
 * Returns true if the JSON predicate represented by "predicateString" filters
 * on the field with name "fieldName".
 *
 * @params {String} fieldName
 *
 * @params {String} predicateString
 *
 * @params {ArrayOfString} polymorphicParams - an array of field names that
 *   should be considered polymorphic. A polymorphic field name is a name that
 *   is used in the following form: "field_name.key=value", where the string
 *   "key" is not static, and can change from one query to another.
 */
function jsonPredicateFiltersOn(fieldName, predicateString, polymorphicParams) {
    assert.string(fieldName, 'fieldName');
    assert.optionalString(predicateString, 'predicateString');
    assert.optionalArrayOfString(polymorphicParams, 'polymorphicParams');

    var idx;
    var krillPred;
    var predFields;
    var parsedJsonPred;
    var res = false;

    try {
        parsedJsonPred = JSON.parse(predicateString);
    } catch (parseErr) {
        return false;
    }

    krillPred = krill.createPredicate(parsedJsonPred);
    predFields = krillPred.fields();

    if (polymorphicParams && polymorphicParams.indexOf(fieldName) !== -1) {
        for (idx = 0; idx < predFields.length; ++idx) {
            if (predFields[idx].indexOf(fieldName + '.') === 0) {
                res = true;
                break;
            }
        }
    } else {
        res = predFields.indexOf(fieldName) !== -1;
    }

    return res;
}

exports.jsonPredicateFiltersOn = jsonPredicateFiltersOn;