'use strict';
const { MongoClient } = require('mongodb');
async function connectDatabase(config) {
  const client = new MongoClient(config.mongoUri, {
    maxPoolSize: 20,
    serverSelectionTimeoutMS: 10000,
  });
  await client.connect();
  const db = client.db(config.dbName);
  await prepareDatabase(db);
  return { client, db };
}
async function prepareDatabase(db) {
  await Promise.all([
    db.collection('users').createIndex({ email: 1 }, { unique: true }),
    db.collection('users').createIndex({ 'apiKey.hash': 1 }, { unique: true, sparse: true }),
    db.collection('users').createIndex({ 'sessions.hash': 1 }, { unique: true, sparse: true }),
    db.collection('gst_records').createIndex({ gstin: 1 }, { unique: true }),
  ]);
}
module.exports = { connectDatabase, prepareDatabase };
