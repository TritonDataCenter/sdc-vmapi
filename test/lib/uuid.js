var uuid = require('uuid');

/*
 * Returns a string that represents the first few characters of a version 4
 * UUID.
 */
function generateShortUuid() {
    return uuid.v4().split('-')[0];
}

module.exports = {
    generateShortUuid: generateShortUuid
};