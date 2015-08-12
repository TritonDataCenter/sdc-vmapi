/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var assert = require('assert-plus');
var jsprim = require('jsprim');

var errors = require('../errors');
var sortValidation = require('../validation/sort');

var util = require('./util');

// Identifies what VM field provides a strict total ordering.
var STRICT_TOTAL_ORDER_FIELD = 'uuid';

/*
 * Parses a marker JSON string of the form:
 *
 * {"uuid": "some-uu-id", "create_timestamp": "09-09-2015 08:00:00"}
 *
 * into a JavaScript object.
 *
 * Returns an object that has two properties:
 *
 * - marker: null if "markerJSONString" couldn't be parsed as a string
 * representing an object literal, otherwise an object instance that
 * corresponds to the parsed string.
 *
 * - parseErrors: a list of strings that describe the errors encountered when
 * parsing "markerJSONString".
 *
 */
function parseMarkerJSONString(markerJSONString) {
    markerJSONString = markerJSONString || '';
    assert.string(markerJSONString);

    var errs = [];
    var marker = null;

    try {
        marker = JSON.parse(markerJSONString);
    } catch (err) {
        errs.push('Could not parse marker as an object JSON representation, ' +
        'reason: ' + err.message);
    }

    if (marker !== null) {
        if (Object.prototype.toString.call(marker) !== '[object Object]') {
            errs.push('Marker must represent an object.');
            marker = null;
        }
    }

    if (marker !== null) {
        errs = errs.concat(convertMarkerFields(marker));
        if (errs.length > 0)
            marker = null;
    }

    return { marker: marker, parseErrors: errs };
}

function convertMarkerTimestamp(markerObject, fieldName) {
    assert.object(markerObject, 'markerObject must be an object');
    assert.string(fieldName, 'fieldName must be an object');

    var timestamp = jsprim.parseDateTime(markerObject[fieldName]).getTime();
    if (isNaN(timestamp))
        return false;

    markerObject[fieldName] = timestamp;

    return true;
}

var MARKER_FIELDS_CONVERSIONS = {
    create_timestamp: convertMarkerTimestamp
};

function convertMarkerFields(markerObject) {
    var errs = [];

    Object.keys(MARKER_FIELDS_CONVERSIONS).forEach(function (fieldName) {
        var field = markerObject[fieldName];
        if (field !== undefined) {
            if (!MARKER_FIELDS_CONVERSIONS[fieldName](markerObject,
                fieldName)) {
                errs.push('Marker has an invalid ' + fieldName + ' field: ' +
                    field);
            }
        }
    });

    return errs;
}

/*
 * Validates an object "marker" that represents a marker against a string that
 * represents a sort parameter. Returns an array of validation errors. Returns
 * an empty array if no error was found.
 *
 */
function validateMarker(marker, sort) {
    assert.object(marker, 'marker must be an object');
    assert.optionalString(sort, 'sort must be an optional string');

    var errs = [];

    if (!strictTotalOrderFieldInMarker(marker)) {
        errs.push('A marker needs to have a ' + STRICT_TOTAL_ORDER_FIELD +
            ' property from which a strict total order can be established');
    }

    if (sort !== undefined) {
        // Make sure that all fields used to sort the results set
        // are present in the marker so that a strict total order can be
        // established by the marker over the sorted results set.
        if (!sortFieldInMarker(sort, marker)) {
            errs.push('All sort fields must be present in marker.' +
                ' Sort fields: ' + sort + '.');
        }
    }

    // Conversely, make sure that all marker fields are present in the
    // sort parameter so that a strict total order can be established by
    // the marker over the sorted results set.
    if (!allMarkerFieldsInSort(marker, sort)) {
        errs.push('All marker keys except ' + STRICT_TOTAL_ORDER_FIELD +
            ' must be present in the sort parameter.' + ' Sort fields: ' +
            sort + '.');
    }

    return errs;
}

/*
 * Returns true if the string "sortField" is also one of the marker's object
 * field.
 *
 * For instance, it returns true if:
 * - sortField is "create_timestamp" and marker is
 * "{"uuid": "some-uuid", "create_timestamp": "09-09-2015 08:00:00"}
 *
 * It returns false if:
 * - sortField is "create_timestamp" and marker is
 * "{"uuid": "some-uuid"}
 */
function sortFieldInMarker(sortField, marker) {
    assert.string(sortField, 'sortField');
    assert.object(marker, 'marker');

    // If sortField specifies an order with 'field.ASC' or 'field.DESC',
    // remove the order and just keep the sort field name.
    sortField = sortField.split('.')[0];

    return Object.keys(marker).some(function (markerField) {
        return sortField === markerField;
    });
}

/*
 * Returns true if all fields in marker "marker" except "uuid" are also present
 * in the sort fields represented by "sort", false otherwise.
 *
 * For instance, it returns true if:
 * - marker is "{"uuid": "some-uuid", "create_timestamp": "09-09-2015 08:00:00"}
 * - sort is "create_timestamp"
 *
 * It returns false if:
 * - marker is "{"uuid": "some-uuid", "create_timestamp": "09-09-2015 08:00:00"}
 * - sort is "brand"
 */
function allMarkerFieldsInSort(marker, sortCriteria) {
    assert.object(marker, 'marker must be an object');
    assert.optionalString(sortCriteria, 'sort must be a string or undefined');

    sortCriteria = sortCriteria || '';

    // If the sortCriteria string is not a valid sort criteria,
    // then assume that all marker fields are not in the sort
    // criteria.
    if (!sortValidation.isValidSortCriteria(sortCriteria))
        return false;

    var markerFields = Object.keys(marker);
    if (markerFields.length === 0) {
        // A marker object with no property have all its fields
        // included in "sortCriteria", since it has none.
        return true;
    }

    // If sortField specifies an order with 'field.ASC' or 'field.DESC',
    // remove the order and just keep the sort field name.
    var sortField = sortCriteria.split('.')[0];

    return markerFields.every(function (markerField) {
        return isStrictTotalOrderField(markerField) ||
            markerField === sortField;
        });
}

/*
 * Returns true if there's a field that can be used to establish
 * a strict total order on the vms data set, false otherwise.
 */
function strictTotalOrderFieldInMarker(marker) {
    assert.object(marker, 'marker must be an object');

    return Object.keys(marker).some(isStrictTotalOrderField);
}

function isStrictTotalOrderField(orderKey) {
    assert.string(orderKey, 'orderKey must be a string');

    return orderKey === STRICT_TOTAL_ORDER_FIELD;
}

function strictTotalOrderField() {
    return STRICT_TOTAL_ORDER_FIELD;
}

/*
 * Returns true if the marker object "marker" identifies the VM object "vm",
 * false otherwise.
 */
function markerIdentifiesObject(marker, vm) {
    assert.object(marker, 'marker must be an object');
    assert.object(vm, 'vm must be an object');

    return marker[STRICT_TOTAL_ORDER_FIELD] !== null &&
         marker[STRICT_TOTAL_ORDER_FIELD] !== undefined &&
         marker[STRICT_TOTAL_ORDER_FIELD] === vm[STRICT_TOTAL_ORDER_FIELD];
}

module.exports = {
    parseMarkerJSONString: parseMarkerJSONString,
    validateMarker: validateMarker,
    strictTotalOrderField: strictTotalOrderField,
    isStrictTotalOrderField: isStrictTotalOrderField,
    markerIdentifiesObject: markerIdentifiesObject
};
