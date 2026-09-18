'use strict';
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const { createApp } = require('../../backend/app');
const { prepareDatabase } = require('../../backend/database');
const { readConfig } = require('../../backend/config');
async function startTestApp({ liveLookup, apiLimit = 1000, production = false, mailer } = {}) {
  const mongo = await MongoMemoryServer.create({ binary: { version: '8.0.12' } });
  const client = new MongoClient(mongo.getUri()); await client.connect();
  const db = client.db('sandbee_disposable_test'); await prepareDatabase(db);
  const config = readConfig({ MONGODB_URI: mongo.getUri(), SESSION_SECRET: 'test-secret-for-isolated-local-tests-only' });
  config.apiLimit = apiLimit; config.authLimit = 1000;
  config.production = production;
  if (production) config.cookieName = '__Host-sandbee_session';
  let calls = 0; const mailbox = [];
  const testMailer = mailer || { send: async message => { mailbox.push(message); } };
  const app = createApp({ db, config, mailer: testMailer, liveLookup: async gstin => { calls++; return liveLookup ? liveLookup(gstin) : { status: 'success', details: { gstin, legalName: 'Example Business', tradeName: 'Studio example', status: 'Active', address: 'Test address' } }; } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`; config.appUrl = base;
  async function request(route, { method = 'GET', body, cookie, csrf, key, headers = {} } = {}) {
    const response = await fetch(base + route, { method, headers: { origin: base, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, headers: response.headers, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  return { base, app, db, config, request, mailbox, calls: () => calls, close: async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await Promise.allSettled(app.locals.otp.deliveries); await client.close(); await mongo.stop(); } };
}
module.exports = { startTestApp };
