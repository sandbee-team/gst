'use strict';
const https = require('node:https');
const CAPTCHA_URL = 'https://services.gst.gov.in/services/captcha?rnd=';
const DETAILS_URL = 'https://services.gst.gov.in/services/api/search/taxpayerDetails';
const CAPTCHA_PATTERN = /^[0-9]{6}$/;
class GstError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function normalizeGstin(value) { return typeof value === 'string' ? value.trim().toUpperCase() : ''; }
function validGstNumber(value) {
  const gstin = normalizeGstin(value);
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z][Z1-9A-J][0-9A-Z]$/.test(gstin)) return false;
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let factor = 2, sum = 0;
  for (let i = 13; i >= 0; i--) {
    const digit = chars.indexOf(gstin[i]) * factor;
    sum += Math.floor(digit / 36) + digit % 36;
    factor = factor === 2 ? 1 : 2;
  }
  return chars[(36 - sum % 36) % 36] === gstin[14];
}
// Native HTTPS works with this portal where undici fetch can reset connections.
// TLS verification stays enabled; the deadline includes response body transfer.
function request(url, { method = 'GET', headers = {}, body, timeoutMs = 15000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, signal, headers: {
      accept: '*/*', 'user-agent': 'GST-Lookup/1.0', ...headers,
      ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
    } }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) req.destroy(new GstError('RESPONSE_TOO_LARGE', 'Portal response exceeded 2 MB.'));
        else chunks.push(chunk);
      });
      res.on('error', err => { clearTimeout(timer); reject(err); });
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }); });
    });
    const timer = setTimeout(() => req.destroy(new GstError('TIMEOUT', 'GST portal request timed out.')), timeoutMs);
    req.on('error', err => { clearTimeout(timer); reject(err); });
    req.end(body);
  });
}
function checkStatus(response) {
  if (response.status === 429) throw new GstError('RATE_LIMITED', 'GST portal rate limit reached. Please try again later.');
  if (response.status === 403) throw new GstError('ACCESS_DENIED', 'GST portal denied the request.');
  if (response.status < 200 || response.status >= 300) throw new GstError('HTTP_ERROR', `GST portal returned HTTP ${response.status}.`);
}
class GstClient {
  constructor({ transport = request, timeoutMs = 15000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    this.transport = transport; this.timeoutMs = timeoutMs; this.sleep = sleep;
  }
  async getCaptcha({ signal } = {}) {
    let res;
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      try { res = await this.transport(CAPTCHA_URL + Math.random(), { timeoutMs: this.timeoutMs, signal }); break; }
      catch (error) {
        if (attempt || !['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'TIMEOUT'].includes(error.code)) throw error;
        await this.sleep(300);
      }
    }
    checkStatus(res);
    const mime = (res.headers['content-type'] || '').split(';')[0];
    if (!['image/png', 'image/jpeg', 'image/gif'].includes(mime) || res.buffer.length < 20) {
      throw new GstError('INVALID_RESPONSE', 'GST portal did not return a CAPTCHA image.');
    }
    const cookies = res.headers['set-cookie'] || [];
    const pairs = (Array.isArray(cookies) ? cookies : [cookies]).map(c => c.split(';')[0].trim());
    if (!pairs.some(c => /^CaptchaCookie=.+/.test(c))) throw new GstError('MISSING_COOKIE', 'GST portal did not return a CAPTCHA session.');
    return { buffer: res.buffer, mime, cookie: pairs.join('; '), createdAt: Date.now() };
  }
  async getDetails(gstin, captcha, challenge, { signal } = {}) {
    gstin = normalizeGstin(gstin);
    if (!validGstNumber(gstin)) throw new GstError('INVALID_GSTIN', 'GSTIN format or checksum is invalid.');
    if (!CAPTCHA_PATTERN.test(captcha)) throw new GstError('INVALID_INPUT', 'CAPTCHA must contain exactly six digits.');
    const res = await this.transport(DETAILS_URL, {
      method: 'POST', timeoutMs: this.timeoutMs, signal,
      headers: { 'content-type': 'application/json', cookie: challenge.cookie },
      body: JSON.stringify({ gstin, captcha }),
    });
    checkStatus(res);
    let data;
    try { data = JSON.parse(res.buffer.toString('utf8')); }
    catch { throw new GstError('INVALID_RESPONSE', 'GST portal returned a non-JSON response.'); }
    const code = data?.errorCode || data?.error?.error_cd;
    if (code === 'SWEB_9000') throw new GstError('INVALID_CAPTCHA', 'CAPTCHA was rejected or expired.');
    if (code === 'SWEB_9035') throw new GstError('GSTIN_NOT_FOUND', 'GSTIN was not found by the portal.');
    if (code || data?.error) throw new GstError('PORTAL_ERROR', `GST portal reported an error${code ? ` (${code})` : ''}.`);
    if (data?.gstin !== gstin || typeof data?.lgnm !== 'string' || typeof data?.sts !== 'string') {
      throw new GstError('INVALID_RESPONSE', 'GST portal returned incomplete or unexpected taxpayer details.');
    }
    return {
      gstin: data.gstin, status: data.sts, legalName: data.lgnm, tradeName: data.tradeNam,
      companyType: data.ctb, taxpayerType: data.dty, registrationDate: data.rgdt,
      cancellationDate: data.cxdt || null, businessNature: data.nba,
      address: data.pradr?.adr || null, stateJurisdiction: data.stj, centreJurisdiction: data.ctj,
    };
  }
}
module.exports = { GstClient, GstError, validGstNumber, normalizeGstin, CAPTCHA_PATTERN };
