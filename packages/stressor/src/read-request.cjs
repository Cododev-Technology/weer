/**
 * setupRequest of the read requests: a random code from the pool. A file of its own so that
 * autocannon can load it in its worker threads (--workers).
 */

const codes = require('./codes.cjs');

module.exports = (req, context) => {
  const codePool = codes.load(context.output);
  req.path = `/${codePool[Math.floor(Math.random() * codePool.length)]}`;
  return req;
};
