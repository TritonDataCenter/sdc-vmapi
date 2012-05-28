/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * A brief overview of this source file: what is its purpose.
 */



/*
 * Shallow clone
 */
function clone(obj) {
    if (null == obj || 'object' != typeof obj)
        return obj;

    var copy = obj.constructor();

    for (var attr in obj) {
        if (obj.hasOwnProperty(attr))
            copy[attr] = obj[attr];
    }
    return copy;
}

exports.clone = clone;



/*
 * Simple object merge
 *   merge(a, b) will merge b attributes into a
 */
function simpleMerge(a, b) {
    if (!a || typeof(a) !== 'object')
        throw new TypeError('First object is required (object)');
    if (!b || typeof(b) !== 'object')
        throw new TypeError('Second object is required (object)');

    var newA = clone(a);
    var bkeys = Object.keys(b);

    bkeys.forEach(function (key) {
        newA[key] = b[key];
    })

    return newA;
}

exports.simpleMerge = simpleMerge;



/*
 * Shallow comparison of two objects. ignoreKeys can be an array of keys that
 * the comparison should ignore if needed
 */
exports.shallowEqual = function(a, b, ignoreKeys) {
    var akeys = Object.keys(a);
    var bkeys = Object.keys(b);

    if (!ignoreKeys) ignoreKeys = [];
    if (akeys.length != bkeys.length)
        return false;

    for (var i = 0; i < akeys.length; i++) {
        var key = akeys[i];

        if (ignoreKeys.indexOf(key) == -1 && (a[key] != b[key]))
            return false;
    }

    return true;
};
