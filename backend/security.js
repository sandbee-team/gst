'use strict';
const { randomBytes, createHash, createHmac, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const derive = promisify(scrypt);
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 64, options);
  return `scrypt$${salt}$${hash.toString('hex')}`;
}
async function verifyPassword(password, encoded) {
  const [, salt, expected] = (encoded || '').split('$');
  // Do the same expensive operation for nonexistent accounts.
  const actual = await derive(password, salt || '00000000000000000000000000000000', 64, options);
  const target = Buffer.from(expected || '00'.repeat(64), 'hex');
  return target.length === actual.length && timingSafeEqual(target, actual) && Boolean(encoded);
}
const csrfToken = (session, secret) =>
  createHmac('sha256', secret).update(`csrf:${session}`).digest('base64url');
function equalToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
module.exports = { hashToken, newToken, hashPassword, verifyPassword, csrfToken, equalToken };
