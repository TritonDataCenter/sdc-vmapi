var uuid = require('libuuid');

/*
 * Returns a string that represents the first few characters of a version 4
 * UUID.
 */
function generateShortUuid() {
    return uuid.create().split('-')[0];
}

module.exports = {
    generateShortUuid: generateShortUuid
};