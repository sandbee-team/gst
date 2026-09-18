'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/saas');
const { GstService } = require('../backend/gst-service');
const { hashToken } = require('../backend/security');
const gstin = '09AAFPC6958E1ZN', password = 'Test-password-934!';
let env, sequence = 0;
before(async () => { env = await startTestApp(); });
after(async () => { await env?.close(); });
async function account(onboard = true) {
  const email = `test${++sequence}@example.com`;
  const signup = await env.request('/api/auth/signup', { method: 'POST', body: { name: 'Test User', email, password } });
  assert.equal(signup.status, 200);
  const auth = { cookie: signup.cookie, csrf: signup.body.csrfToken };
  await env.request('/api/auth/verification/confirm', { ...auth, method: 'POST', body: { code: env.mailbox.findLast(m => m.to === email).code } });
  if (onboard) assert.equal((await env.request('/api/onboarding', { ...auth, method: 'POST', body: { company: 'Test workspace', useCase: 'development' } })).status, 200);
  return { ...auth, email, user: signup.body.user };
}
async function key(auth) { const res = await env.request('/api/keys', { ...auth, method: 'POST', body: { name: 'Integration key' } }); assert.equal(res.status, 201); return res.body.token; }
test('signup validates shapes, requires same origin, and hashes credentials', async () => {
  assert.equal((await env.request('/api/auth/signup', { method: 'POST', headers: { origin: 'https://evil.example' }, body: {} })).status, 403);
  assert.equal((await env.request('/api/auth/login', { method: 'POST', body: { email: { $ne: null }, password } })).status, 400);
  assert.equal((await env.request('/api/auth/signup', { method: 'POST', body: { name: 'Test', email: 'weak@example.com', password: 'short' } })).status, 400);
  const auth = await account(false), user = await env.db.collection('users').findOne({ email: auth.email });
  assert.match(user.passwordHash, /^scrypt\$/); assert.notEqual(user.passwordHash, password);
  assert.equal(user.sessions[0].hash, hashToken(auth.cookie.split('=')[1]));
  assert.equal((await env.request('/api/keys', { ...auth, method: 'POST', body: { name: 'key' } })).status, 403);
  const me = await env.request('/api/auth/me', auth);
  assert.equal(me.status, 200); assert.ok(!JSON.stringify(me.body).includes('passwordHash')); assert.ok(!JSON.stringify(me.body).includes('sessions'));
  assert.match((await env.request('/api/auth/login', { method: 'POST', body: { email: auth.email, password } })).headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await env.request('/api/auth/login', { method: 'POST', body: { email: auth.email, password: 'incorrect' } })).status, 401);
});
test('session mutations enforce CSRF and API accepts only generated Bearer keys', async () => {
  const auth = await account();
  assert.equal((await env.request('/api/keys', { cookie: auth.cookie, method: 'POST', body: { name: 'key' } })).status, 403);
  assert.equal((await env.request('/api/keys', { ...auth, method: 'POST', body: { name: 'key' }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await env.request(`/api/v1/gstin/${gstin}`, auth)).status, 401);
  assert.equal((await env.request(`/api/v1/gstin/${gstin}`, { key: 'invented' })).status, 401);
  assert.equal((await env.request('/api/lookup', { method: 'POST', body: { gstin } })).status, 404);
  const token = await key(auth), saved = await env.db.collection('users').findOne({ email: auth.email });
  assert.equal(saved.apiKey.hash, hashToken(token)); assert.ok(!JSON.stringify(saved).includes(token));
});
test('database reuse, cold LRU and concurrent usage remain isolated per account', async () => {
  const first = await account(), second = await account(); const a = await key(first), b = await key(second);
  const before = env.calls();
  const responses = await Promise.all(Array.from({ length: 8 }, () => env.request(`/api/v1/gstin/${gstin}`, { key: a })));
  assert.ok(responses.every(r => r.status === 200)); assert.equal(env.calls() - before, 1);
  assert.equal(await env.db.collection('gst_records').countDocuments({ gstin }), 1);
  assert.equal(env.app.locals.service.cache.get(gstin), 1);
  env.app.locals.service.cache.clear();
  const saved = await env.request(`/api/v1/gstin/${gstin}`, { key: b }); assert.equal(saved.body.meta.source, 'database');
  const restarted = new GstService({ db: env.db, liveLookup: () => { throw Error('must not call portal'); } });
  assert.equal((await restarted.get(gstin)).source, 'database');
  assert.equal((await env.request('/api/auth/me', first)).body.user.usage.total, 8);
  assert.equal((await env.request('/api/auth/me', second)).body.user.usage.total, 1);
  assert.equal((await env.request('/api/v1/gstin/invalid', { key: b })).status, 400);
  assert.equal((await env.request('/api/auth/me', second)).body.user.usage.total, 1);
  assert.deepEqual((await env.db.listCollections().toArray()).map(x => x.name).sort(), ['gst_records', 'users']);
  const index = (await env.db.collection('gst_records').indexes()).find(x => x.key.gstin); assert.equal(index.unique, true);
});
test('rotation, revocation and password change invalidate keys and sessions', async () => {
  const auth = await account(), old = await key(auth), current = await key(auth);
  assert.equal((await env.request(`/api/v1/gstin/${gstin}`, { key: old })).status, 401);
  assert.equal((await env.request(`/api/v1/gstin/${gstin}`, { key: current })).status, 200);
  assert.equal((await env.request('/api/keys', { ...auth, method: 'DELETE' })).status, 200);
  assert.equal((await env.request(`/api/v1/gstin/${gstin}`, { key: current })).status, 401);
  const token = await key(auth);
  assert.equal((await env.request('/api/auth/password', { ...auth, method: 'POST', body: { currentPassword: password, password: 'Replacement-password-12!' } })).status, 200);
  assert.equal((await env.request('/api/auth/me', auth)).status, 401);
  assert.equal((await env.request(`/api/v1/gstin/${gstin}`, { key: token })).status, 401);
  assert.equal((await env.request('/api/auth/login', { method: 'POST', body: { email: auth.email, password } })).status, 401);
});
test('uncertain OCR never creates a cached record or increments usage', async () => {
  const isolated = await startTestApp({ liveLookup: async () => ({ status: 'needs_captcha', challenge: { cookie: 'must-stay-private' } }) });
  try {
    const signed = await isolated.request('/api/auth/signup', { method: 'POST', body: { name: 'Failure User', email: 'failure@example.com', password } });
    const auth = { cookie: signed.cookie, csrf: signed.body.csrfToken };
    await isolated.request('/api/auth/verification/confirm', { ...auth, method: 'POST', body: { code: isolated.mailbox.at(-1).code } });
    await isolated.request('/api/onboarding', { ...auth, method: 'POST', body: { company: 'Failure test', useCase: 'development' } });
    const token = (await isolated.request('/api/keys', { ...auth, method: 'POST', body: { name: 'key' } })).body.token;
    const response = await isolated.request(`/api/v1/gstin/${gstin}`, { key: token });
    assert.equal(response.status, 503); assert.equal(response.headers.get('retry-after'), '30'); assert.ok(!JSON.stringify(response.body).includes('must-stay-private'));
    assert.equal(await isolated.db.collection('gst_records').countDocuments(), 0);
    assert.equal((await isolated.request('/api/auth/me', auth)).body.user.usage.total, 0);
  } finally { await isolated.close(); }
});
test('expired sessions and logout reject future session requests', async () => {
  const auth = await account();
  await env.db.collection('users').updateOne({ email: auth.email }, { $set: { 'sessions.0.expiresAt': new Date(0) } });
  assert.equal((await env.request('/api/auth/me', auth)).status, 401);
  const other = await account();
  assert.equal((await env.request('/api/auth/logout', { ...other, method: 'POST', body: {} })).status, 200);
  assert.equal((await env.request('/api/auth/me', other)).status, 401);
});
test('production cookies and account limits remain enforced', async () => {
  const isolated = await startTestApp({ apiLimit: 1, production: true });
  try {
    const signed = await isolated.request('/api/auth/signup', { method: 'POST', body: { name: 'Secure User', email: 'secure@example.com', password } });
    const cookie = signed.headers.get('set-cookie');
    assert.match(cookie, /^__Host-sandbee_session=/); assert.match(cookie, /Secure/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/); assert.ok(!cookie.includes('Domain='));
    assert.match(signed.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const auth = { cookie: signed.cookie, csrf: signed.body.csrfToken };
    await isolated.request('/api/auth/verification/confirm', { ...auth, method: 'POST', body: { code: isolated.mailbox.at(-1).code } });
    await isolated.request('/api/onboarding', { ...auth, method: 'POST', body: { company: 'Secure workspace', useCase: 'development' } });
    const token = (await isolated.request('/api/keys', { ...auth, method: 'POST', body: { name: 'key' } })).body.token;
    assert.equal((await isolated.request(`/api/v1/gstin/${gstin}`, { key: token })).status, 200);
    const blocked = await isolated.request(`/api/v1/gstin/${gstin}`, { key: token });
    assert.equal(blocked.status, 429); assert.ok(blocked.headers.has('ratelimit'));
    assert.equal((await isolated.request('/api/auth/me', auth)).body.user.usage.total, 1);
  } finally { await isolated.close(); }
});
test('unique GST index prevents duplicate snapshots and queue saturation is bounded', async () => {
  await assert.rejects(env.db.collection('gst_records').insertOne({ gstin, response: {} }), { code: 11000 });
  const service = new GstService({ db: env.db, liveLookup: async () => {} });
  await service.acquire();
  const waiting = Array.from({ length: 4 }, () => service.acquire());
  await assert.rejects(service.acquire(), { code: 'SERVICE_BUSY' });
  for (const next of waiting) { service.release(); await next; }
  service.release(); assert.equal(service.active, false); assert.equal(service.queue.length, 0);
});
