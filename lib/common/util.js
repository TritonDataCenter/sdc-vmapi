/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */



/*
 * Shallow clone
 */
function clone(obj) {
    if (null === obj || 'object' != typeof (obj)) {
        return obj;
    }

    var copy = obj.constructor();

    for (var attr in obj) {
        if (obj.hasOwnProperty(attr)) {
            copy[attr] = obj[attr];
        }
    }
    return copy;
}

exports.clone = clone;



/*
 * Simple object merge
 *   merge(a, b) will merge b attributes into a
 */
function simpleMerge(a, b) {
    if (!a || typeof (a) !== 'object') {
        throw new TypeError('First object is required (object)');
    }
    if (!b || typeof (b) !== 'object') {
        throw new TypeError('Second object is required (object)');
    }

    var newA = clone(a);
    var bkeys = Object.keys(b);

    bkeys.forEach(function (key) {
        newA[key] = b[key];
    });

    return newA;
}

exports.simpleMerge = simpleMerge;



/*
 * Shallow comparison of two objects. ignoreKeys can be an array of keys that
 * the comparison should ignore if needed
 */
exports.shallowEqual = function (a, b, ignoreKeys) {
    var akeys = Object.keys(a);
    var bkeys = Object.keys(b);

    if (!ignoreKeys) ignoreKeys = [];
    if (akeys.length != bkeys.length) {
        return false;
    }

    for (var i = 0; i < akeys.length; i++) {
        var key = akeys[i];

        if (ignoreKeys.indexOf(key) == -1 && (a[key] != b[key])) {
            return false;
        }
    }

    return true;
};



/*
 * Gets the diff between two objects. The idea is that A is the outdated object
 * so we want to check which properties that both objects share are different
 * and which properties that B has and A does not, need to be added to A.
 *
 *   Consider these 2 examples:
 *
 *   - Machine running status changes. zone_state will appear in the object B,
 *      meaning that A has an old value for running status compared to B
 *   - Machine alias has been added. alias doesn't exist in A but it is present
 *      in the B object, so it will appear in the diff object as well
 */
function objectDiff(old, newObj) {
    var result = {};
    var i = 0;

    for (i in newObj) {
        // Any object
        if (typeof (old[i]) == 'object' && typeof (newObj[i]) == 'object') {

            // If date objects
            if (old[i].getTime && newObj[i].getTime &&
                    (old[i].getTime() != newObj[i].getTime())) {
                result[i] = newObj[i];

            // Any other object should be fine for our case
            } else {
                result[i] = objectDiff(old[i], newObj[i]);
                if (!result[i]) delete result[i];
            }

        // string, number
        } else if (old[i] != newObj[i]) {
            result[i] = newObj[i];
        }
    }

    if (Object.keys(result).length === 0) {
        return undefined;
    } else {
        return result;
    }
}

exports.objectDiff = objectDiff;



/*
 * Creates a YYYYMMDD date string
 */
exports.timestamp = function (aDate) {
    var date;

    if (aDate) {
        date = aDate;
    } else {
        date = new Date();
    }

    var month = date.getMonth() + 1;
    month = (month < 9 ? '0' + month : month.toString());

    return date.getFullYear().toString() +
           month +
           date.getDate().toString();
};
