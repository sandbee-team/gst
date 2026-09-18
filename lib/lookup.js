'use strict';
const { GstError, validGstNumber, normalizeGstin, CAPTCHA_PATTERN } = require('./gst-client');
async function runLookup(gstin, { client, solver, maxAttempts = 3, minScore = 0.8, manual = false, onProgress = () => {}, signal = AbortSignal.timeout(60000) }) {
  gstin = normalizeGstin(gstin);
  if (!validGstNumber(gstin)) throw new GstError('INVALID_GSTIN', 'GSTIN format or checksum is invalid.');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new Error('maxAttempts must be 1 to 5.');
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) throw new Error('minScore must be between 0 and 1.');
  const started = Date.now();
  let submissions = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    signal.throwIfAborted();
    onProgress(`Fetching CAPTCHA (${attempt}/${maxAttempts})`);
    const challenge = await client.getCaptcha({ signal });
    let prediction = null, reason = 'Enter the six digits shown in the image.';
    if (!manual) {
      try { prediction = await solver.solve(challenge.buffer); }
      catch { reason = 'Local OCR is unavailable. Enter the CAPTCHA manually or check the OCR setup.'; }
    }
    signal.throwIfAborted();
    const accepted = prediction?.autoSubmit === true && CAPTCHA_PATTERN.test(prediction.text) && Number.isFinite(prediction.score) && prediction.score >= minScore;
    if (manual || !accepted) {
      if (prediction) reason = 'OCR is uncertain. Check or correct the suggested digits.';
      if (!manual && prediction && attempt < maxAttempts) {
        onProgress('OCR is uncertain; trying a fresh CAPTCHA.');
        continue;
      }
      return { status: 'needs_captcha', gstin, challenge, prediction, reason, attempts: attempt };
    }
    onProgress(`OCR completed in ${prediction.elapsedMs} ms; checking with GST portal`);
    try {
      submissions++;
      const details = await client.getDetails(gstin, prediction.text, challenge, { signal });
      return { status: 'success', details, attempts: attempt, submissions, elapsedMs: Date.now() - started, ocrMs: prediction.elapsedMs };
    } catch (error) {
      if (['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'TIMEOUT'].includes(error.code) && attempt < maxAttempts) {
        onProgress('Portal connection interrupted; restarting with a fresh CAPTCHA.');
        continue;
      }
      if (error.code !== 'INVALID_CAPTCHA') throw error;
      if (attempt === maxAttempts) {
        return { status: 'needs_captcha', gstin, challenge: await client.getCaptcha({ signal }), prediction: null,
          reason: 'Automatic attempts were rejected. Enter this fresh CAPTCHA.', attempts: attempt };
      }
    }
  }
}
async function lookup(gstin, options) {
  try { return await runLookup(gstin, options); }
  catch (error) {
    if (['AbortError', 'TimeoutError'].includes(error.name) || error.code === 'ABORT_ERR') {
      throw new GstError('LOOKUP_TIMEOUT', 'Lookup timed out or was cancelled. Please try again.');
    }
    throw error;
  }
}
module.exports = { lookup };
