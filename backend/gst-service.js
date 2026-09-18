'use strict';
const { LRUCache } = require('lru-cache');
const { normalizeGstin, validGstNumber } = require('../lib/gst-client');
const { AppError } = require('./errors');

class GstService {
  constructor({ db, liveLookup, cacheMax = 10000 }) {
    this.records = db.collection('gst_records');
    this.liveLookup = liveLookup;
    this.cache = new LRUCache({ max: cacheMax }); // Exactly GSTIN -> 1, no response bodies.
    this.pending = new Map();
    this.active = false;
    this.queue = [];
  }
  async acquire() {
    if (!this.active) {
      this.active = true;
      return;
    }
    if (this.queue.length >= 4)
      throw new AppError(503, 'SERVICE_BUSY', 'Live lookup is busy. Please retry shortly.');
    await new Promise((resolve, reject) => {
      const job = {
        resolve,
        timer: setTimeout(() => {
          this.queue = this.queue.filter((item) => item !== job);
          reject(
            new AppError(503, 'SERVICE_BUSY', 'Live lookup queue timed out. Please retry shortly.'),
          );
        }, 10000),
      };
      this.queue.push(job);
    });
  }
  release() {
    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    } else this.active = false;
  }
  async find(gstin) {
    const record = await this.records.findOne(
      { gstin },
      { projection: { _id: 0, response: 1, fetchedAt: 1 } },
    );
    if (record) {
      this.cache.set(gstin, 1);
      return { data: record.response, source: 'database', fetchedAt: record.fetchedAt };
    }
    this.cache.delete(gstin);
    return null;
  }
  async get(value) {
    const gstin = normalizeGstin(value);
    if (!validGstNumber(gstin))
      throw new AppError(400, 'INVALID_GSTIN', 'GSTIN format or checksum is invalid.');
    const markerHit = this.cache.get(gstin) === 1;
    // A marker miss is not proof of DB absence (eviction/restart).
    const saved = await this.find(gstin);
    if (saved) return { ...saved, markerHit };
    if (this.pending.has(gstin)) return this.pending.get(gstin);
    const job = this.fetchLive(gstin);
    this.pending.set(gstin, job);
    try {
      return await job;
    } finally {
      this.pending.delete(gstin);
    }
  }
  async fetchLive(gstin) {
    await this.acquire();
    try {
      const existing = await this.find(gstin);
      if (existing) return { ...existing, markerHit: false };
      const result = await this.liveLookup(gstin);
      if (result.status !== 'success')
        throw new AppError(
          503,
          'CAPTCHA_UNCERTAIN',
          'The GST portal could not be verified automatically. Please retry shortly.',
        );
      if (result.details?.gstin !== gstin)
        throw new AppError(
          502,
          'INVALID_RESPONSE',
          'The GST portal returned an unexpected response.',
        );
      const fetchedAt = new Date();
      try {
        await this.records.updateOne(
          { gstin },
          { $setOnInsert: { gstin, response: result.details, fetchedAt } },
          { upsert: true },
        );
      } catch (error) {
        if (error.code !== 11000) throw error;
      }
      // Return the persisted winner if another process inserted the same GSTIN.
      const record = await this.find(gstin);
      return { ...record, source: 'live', markerHit: false };
    } finally {
      this.release();
    }
  }
}
module.exports = { GstService };
