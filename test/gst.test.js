'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GstClient, GstError, validGstNumber } = require('../lib/gst-client');
const { lookup } = require('../lib/lookup');
const gstin = '27AAPFU0939F1ZV';
const image = Buffer.from('a fixture image with enough bytes');
const challenge = { buffer: image, mime: 'image/png', cookie: 'CaptchaCookie=secret==' };
const prediction = { text: '001122', score: 0.98, elapsedMs: 25, autoSubmit: true };
const taxpayer = { gstin, sts: 'Active', lgnm: 'Fixture Company', pradr: null };
function response(data, status = 200) { return { status, headers: {}, buffer: Buffer.from(JSON.stringify(data)) }; }
function stubs() {
  return { client: { getCaptcha: async () => challenge, getDetails: async () => ({ gstin, legalName: 'Fixture Company' }) }, solver: { solve: async () => prediction } };
}
test('normalizes GSTIN and rejects wrong length, format and checksum', () => {
  assert.equal(validGstNumber(' 27aapfu0939f1zv '), true);
  for (const value of [null, '', gstin + '0', '27AAPFU0939F1ZA', '!!!!!!!!!!!!!!!']) assert.equal(validGstNumber(value), false);
});
test('invalid GSTIN makes no network request', async () => {
  await assert.rejects(lookup('bad', {}), { code: 'INVALID_GSTIN' });
});
test('retains complete cookie values and session cookies but strips attributes', async () => {
  const client = new GstClient({ transport: async () => ({ status: 200, headers: { 'content-type': 'image/png', 'set-cookie': ['CaptchaCookie=abc==; Secure; Path=/', 'Session=sid; HttpOnly'] }, buffer: image }) });
  assert.equal((await client.getCaptcha()).cookie, 'CaptchaCookie=abc==; Session=sid');
});
test('rejects a challenge without its session cookie', async () => {
  const client = new GstClient({ transport: async () => ({ status: 200, headers: { 'content-type': 'image/png' }, buffer: image }) });
  await assert.rejects(client.getCaptcha(), { code: 'MISSING_COOKIE' });
});
test('rejects HTML masquerading as a challenge', async () => {
  const client = new GstClient({ transport: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, buffer: image }) });
  await assert.rejects(client.getCaptcha(), { code: 'INVALID_RESPONSE' });
});
test('details bind the exact challenge cookie and preserve leading zeroes', async () => {
  const client = new GstClient({ transport: async (_url, options) => {
    assert.equal(options.headers.cookie, challenge.cookie);
    assert.deepEqual(JSON.parse(options.body), { gstin, captcha: '001122' });
    return response(taxpayer);
  } });
  const result = await client.getDetails(gstin, '001122', challenge);
  assert.equal(result.legalName, 'Fixture Company'); assert.equal(result.address, null);
});
test('recognizes both portal error response shapes', async () => {
  for (const data of [{ errorCode: 'SWEB_9000' }, { error: { error_cd: 'SWEB_9000' } }]) {
    const client = new GstClient({ transport: async () => response(data) });
    await assert.rejects(client.getDetails(gstin, '001122', challenge), { code: 'INVALID_CAPTCHA' });
  }
});
test('does not convert unknown or incomplete responses into successful details', async () => {
  for (const data of [{}, { error: { message: 'unavailable' } }, { ...taxpayer, gstin: 'different' }]) {
    const client = new GstClient({ transport: async () => response(data) });
    await assert.rejects(client.getDetails(gstin, '001122', challenge));
  }
});
test('rate limiting stops without retrying', async () => {
  let calls = 0;
  const client = new GstClient({ transport: async () => { calls++; return response({}, 429); } });
  await assert.rejects(lookup(gstin, { client }), { code: 'RATE_LIMITED' });
  assert.equal(calls, 1);
});
test('low scores, malformed guesses, and unavailable OCR require manual input', async () => {
  for (const value of [{ ...prediction, score: 0.1 }, { ...prediction, text: '00112' }, { ...prediction, score: NaN }, null]) {
    const deps = stubs();
    deps.solver.solve = async () => { if (value === null) throw new Error('no Python'); return value; };
    deps.client.getDetails = () => { throw new Error('must not submit'); };
    const result = await lookup(gstin, deps);
    assert.equal(result.status, 'needs_captcha'); assert.equal(result.challenge, challenge);
  }
});
test('manual mode never starts OCR', async () => {
  const deps = stubs(); deps.solver.solve = () => { throw new Error('must not start'); };
  assert.equal((await lookup(gstin, { ...deps, manual: true })).status, 'needs_captcha');
});
test('rejected guesses use fresh cookies and stop after bounded attempts', async () => {
  const deps = stubs(); let fetched = 0, submitted = 0;
  deps.client.getCaptcha = async () => ({ ...challenge, cookie: `CaptchaCookie=${++fetched}` });
  deps.client.getDetails = async (_gstin, _text, item) => {
    submitted++; assert.equal(item.cookie, `CaptchaCookie=${submitted}`);
    throw new GstError('INVALID_CAPTCHA', 'Rejected');
  };
  const result = await lookup(gstin, { ...deps, maxAttempts: 2 });
  assert.equal(submitted, 2); assert.equal(fetched, 3); assert.equal(result.challenge.cookie, 'CaptchaCookie=3');
});
test('network failures never replay a possibly consumed challenge', async () => {
  const deps = stubs(); let calls = 0;
  deps.client.getDetails = async () => { calls++; throw new Error('connection reset'); };
  await assert.rejects(lookup(gstin, deps), /connection reset/); assert.equal(calls, 1);
});
test('successful lookup returns mapped details and timings', async () => {
  const result = await lookup(gstin, stubs());
  assert.equal(result.status, 'success'); assert.equal(result.attempts, 1); assert.equal(result.ocrMs, 25);
});
test('uncertain OCR refreshes within the budget without submitting guesses', async () => {
  const deps = stubs(); let scans = 0, submissions = 0;
  deps.solver.solve = async () => (++scans < 3 ? { ...prediction, autoSubmit: false } : prediction);
  deps.client.getDetails = async () => { submissions++; return { gstin }; };
  const result = await lookup(gstin, deps);
  assert.equal(result.status, 'success'); assert.equal(result.attempts, 3); assert.equal(submissions, 1);
});
test('a high score without agreement cannot trigger automatic submission', async () => {
  const deps = stubs(); let scans = 0;
  deps.solver.solve = async () => { scans++; return { ...prediction, autoSubmit: false }; };
  deps.client.getDetails = () => { throw new Error('must not submit'); };
  assert.equal((await lookup(gstin, deps)).status, 'needs_captcha'); assert.equal(scans, 3);
});
test('GET retries one reset but does not retry indefinitely', async () => {
  let calls = 0;
  const client = new GstClient({ sleep: async () => {}, transport: async () => {
    calls++; throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
  } });
  await assert.rejects(client.getCaptcha(), { code: 'ECONNRESET' }); assert.equal(calls, 2);
});
test('POST reset restarts using a new challenge instead of replaying the payload', async () => {
  const deps = stubs(); let images = 0; const cookies = [];
  deps.client.getCaptcha = async () => ({ ...challenge, cookie: `CaptchaCookie=${++images}` });
  deps.client.getDetails = async (_gstin, _captcha, item) => {
    cookies.push(item.cookie);
    if (cookies.length === 1) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    return { gstin };
  };
  assert.equal((await lookup(gstin, deps)).status, 'success');
  assert.deepEqual(cookies, ['CaptchaCookie=1', 'CaptchaCookie=2']);
});
test('cancelled lookup stops before contacting the portal', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(lookup(gstin, { ...stubs(), signal: controller.signal }), { code: 'LOOKUP_TIMEOUT' });
});

