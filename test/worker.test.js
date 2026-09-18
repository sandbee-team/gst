const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { OcrWorker } = require('../lib/ocr-worker');
const fixture = path.join(__dirname, 'fixtures/ocr-worker.cjs');
function worker(t, mode, options = {}) {
  const item = new OcrWorker({ python: process.execPath, workerArgs: [fixture, mode], ...options });
  t.after(() => item.close()); return item;
}
test('warm worker correlates out-of-order concurrent results', async t => {
  const item = worker(t, 'ok');
  const results = await Promise.all([item.solve(Buffer.from('one')), item.solve(Buffer.from('two'))]);
  assert.deepEqual(results.map(r => r.text), ['000001', '000002']);
});
test('worker timeout rejects pending work and can restart cleanly', async t => {
  const item = worker(t, 'hang', { timeoutMs: 100 });
  await assert.rejects(item.solve(Buffer.from('image')), /timed out/);
  item.workerArgs = [fixture, 'ok'];
  assert.equal((await item.solve(Buffer.from('next'))).text, '000002');
});
test('startup deadline bounds a worker that never becomes ready', async t => {
  const item = worker(t, 'startup-hang', { startupTimeoutMs: 150 });
  await assert.rejects(item.start(), /startup timed out/);
});
test('worker crashes reject all pending jobs without hanging', async t => {
  const item = worker(t, 'crash');
  const results = await Promise.allSettled([item.solve(Buffer.from('one')), item.solve(Buffer.from('two'))]);
  assert.ok(results.every(r => r.status === 'rejected'));
});
test('malformed worker output fails promptly', async t => {
  await assert.rejects(worker(t, 'malformed').solve(Buffer.from('image')), /invalid JSON/);
});
test('missing interpreter fails with a setup message', async t => {
  const item = new OcrWorker({ python: path.join(__dirname, 'missing-python.exe') });
  t.after(() => item.close());
  await assert.rejects(item.solve(Buffer.from('image')), /Cannot start Python/);
});
