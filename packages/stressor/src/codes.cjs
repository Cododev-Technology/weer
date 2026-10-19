/**
 * The codes that read-request.cjs and write-response.cjs share. With --workers, autocannon
 * loads those two in every worker thread, so each thread has its own copy of this module.
 */

const { readSync, openSync, closeSync, existsSync, appendFileSync } = require('fs');

const pool = [];
let loaded = false;

// Seed the code pool from the output file (populated by a prior write run), once per thread
function load(output) {
  if (loaded) return pool;
  loaded = true;

  if (existsSync(output)) {
    const fd = openSync(output, 'r');
    const buffer = Buffer.alloc(1_000_000);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    closeSync(fd);
    const lines = buffer.toString('utf8', 0, bytesRead).split('\n').filter(Boolean);
    if (bytesRead === buffer.length) lines.pop(); // last line may be cut off mid-code
    for (const line of lines) pool.push(line);
  }

  return pool;
}

// The codes of this run go to <output>.new, and the main thread moves it over the output file
// at the end. A worker can't hand them back to the main thread, so every thread writes them itself.
function newFile(output) {
  return `${output}.new`;
}

function add(output, code) {
  load(output).push(code);
  appendFileSync(newFile(output), `${code}\n`, 'utf8');
}

module.exports = { load, newFile, add };
