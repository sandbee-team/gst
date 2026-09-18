'use strict';
// Explicit, bounded smoke test. Does not store GST cookies or taxpayer details.
const fs = require('node:fs/promises');
const { GstClient, validGstNumber, normalizeGstin } = require('../lib/gst-client');
const { OcrWorker } = require('../lib/ocr-worker');
const { lookup } = require('../lib/lookup');

async function main() {
  const gstin = normalizeGstin(process.argv[2]);
  const samples = Number(process.argv[3] || 5);
  const output = process.argv[4];
  if (!validGstNumber(gstin) || !Number.isInteger(samples) || samples < 1 || samples > 10) {
    throw new Error('Usage: node scripts/verify-live.js <GSTIN> [samples:1-10] [output.json]');
  }
  const client = new GstClient(), worker = new OcrWorker();
  const report = { startedAt: new Date().toISOString(), requestedLookups: samples, runs: [], challenges: [] };
  let current;
  const observedClient = {
    getCaptcha: async options => {
      const challenge = await client.getCaptcha(options);
      current = { id: report.challenges.length + 1, portalAccepted: null };
      report.challenges.push(current); return challenge;
    },
    getDetails: async (...args) => {
      try { const details = await client.getDetails(...args); current.portalAccepted = true; return details; }
      catch (error) { if (error.code === 'INVALID_CAPTCHA') current.portalAccepted = false; throw error; }
    },
  };
  const solver = { solve: async bytes => {
    const result = await worker.solve(bytes);
    Object.assign(current, { text: result.text, score: result.score, autoSubmit: result.autoSubmit,
      ocrMs: result.elapsedMs, preprocessing: result.preprocessing });
    return result;
  } };
  try {
    await worker.start();
    for (let i = 0; i < samples; i++) {
      try {
        const result = await lookup(gstin, { client: observedClient, solver });
        report.runs.push({ status: result.status, attempts: result.attempts, submissions: result.submissions,
          elapsedMs: result.elapsedMs, ocrMs: result.ocrMs });
        console.error(`${i + 1}/${samples}: ${result.status}; ${result.attempts} challenge(s)`);
      } catch (error) {
        report.runs.push({ status: 'error', code: error.code || 'NETWORK_ERROR' });
        report.stoppedEarly = true; break;
      }
      if (i + 1 < samples) await new Promise(resolve => setTimeout(resolve, 1500));
    }
  } finally { worker.close(); }
  const successes = report.runs.filter(r => r.status === 'success');
  const times = successes.map(r => r.elapsedMs).sort((a, b) => a - b);
  report.summary = { successfulLookups: successes.length, totalLookups: report.runs.length,
    challenges: report.challenges.length, submitted: report.challenges.filter(c => c.portalAccepted !== null).length,
    accepted: report.challenges.filter(c => c.portalAccepted === true).length,
    rejected: report.challenges.filter(c => c.portalAccepted === false).length,
    medianLookupMs: times.length ? (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2 : null };
  if (output) await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report.summary, null, 2));
  if (successes.length !== samples) process.exitCode = 2;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
