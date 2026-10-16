/**
 * onResponse of the write requests: keeps the new code. A file of its own so that
 * autocannon can load it in its worker threads (--workers).
 */

const codes = require('./codes.cjs');

module.exports = (status, body, context) => {
  if (status === 200) {
    try {
      const { code } = JSON.parse(body);
      if (code) codes.add(context.output, code);
    } catch { }
  }
};
