/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

//
//
// TODO: Allow piping in from profile.d and printing raw data
// TODO: Allow filtering and sorting
// TODO: Allow feeding data to some other tool (to further html-d3)
//

var cp = require('child_process');
var fs = require('fs');
var exec = cp.exec;
var sprintf = require('sprintf').sprintf;

var FILE = './dtrace.out';
var LINES = [];

// Holds list of request totals/averages per method/route
// { 'HEAD /vms': {
//      count: ...,
//      total: ..., // Total latency
//      max: ...,
//      min: ...,
//      avg: ...,
//      success: ...,
//    },
//  'POST /vms': ... }
var requests = {};

function parseLines(cb) {
    var lastLine = '';
    var stream = fs.createReadStream(FILE);

    stream.on('error', function (err) {
        cb(err);
    });

    stream.on('end', function (err) {
        if (lastLine !== '') {
            processLine(lastLine);
            LINES.push(lastLine);
        }

        cb();
    });

    stream.on('data', function onData(chunk) {
        var lines, i;
        lines = (lastLine + chunk).split('\n');

        for (i = 0; i < lines.length - 1; i++) {
            if (lines[i] !== '') {
                processLine(lines[i]);
                LINES.push(lines[i]);
            }
        }
        lastLine = lines[i];
    });
}


function processLine(line) {
    var reqLine, fields, latency, statusCode, success;

    fields = line.split(' ');
    reqLine = fields.slice(0, 2).join(' ');

    if (!requests[reqLine]) {
        requests[reqLine] = {
            count: 0,
            total: 0,
            min: 9999999,
            max: -1,
            success: 0,
            statusCodes: []
        };
    }

    latency = Number(fields[4]);
    statusCode = Number(fields[3]);
    success = (statusCode >= 200 && statusCode < 300);

    requests[reqLine].count++;
    requests[reqLine].total += latency;

    if (requests[reqLine].min > latency) {
        requests[reqLine].min = latency;
    }

    if (requests[reqLine].max < latency) {
        requests[reqLine].max = latency;
    }

    if (success) {
        requests[reqLine].success++;
    }

    if (requests[reqLine].statusCodes.indexOf(fields[3]) === -1) {
        requests[reqLine].statusCodes.push(fields[3]);
    }

    return true;
}


function printSummary() {
    // console.log('\nDisplaying latency summary: ');
    console.log(sprintf('%s %10s %10s %10s %10s %10s',
            'ROUTE', 'TOT REQS', 'MIN', 'AVG', 'MAX', 'STATUS CODES'));

    var reqLines = Object.keys(requests);
    var req, avgRounded;

    reqLines.forEach(function (reqLine) {
        req = requests[reqLine];
        avgRounded = Math.round((req.total / req.count) * 100) / 100;

        console.log(sprintf('%50s %10s %10s %10s %10s %10s',
            reqLine.substr(0, 50), req.count, req.min, avgRounded,
            req.max, req.statusCodes.join(', ')));
    });
}


parseLines(function (err) {
    if (err) {
        console.error(err);
        return;
    }

    // console.log('processed %d requests', LINES.length);
    printSummary();
});
