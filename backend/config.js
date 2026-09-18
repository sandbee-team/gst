'use strict';
function readConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const appUrl = env.APP_URL || 'http://localhost:3000';
  const url = new URL(appUrl);
  if (production && url.protocol !== 'https:')
    throw new Error('Production APP_URL must use HTTPS.');
  if (!env.MONGODB_URI)
    throw new Error('MONGODB_URI is required. Copy .env.example and configure MongoDB.');
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32)
    throw new Error('SESSION_SECRET must contain at least 32 random characters.');
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  const gmailUser = env.GMAIL_USER?.trim() || '';
  const gmailPassword = env.GMAIL_APP_PASSWORD?.replace(/\s/g, '') || '';
  if (Boolean(gmailUser) !== Boolean(gmailPassword))
    throw new Error('Set both GMAIL_USER and GMAIL_APP_PASSWORD.');
  if (production && !gmailUser) throw new Error('Production Gmail SMTP credentials are required.');
  return {
    production,
    appUrl: url.origin,
    port,
    host: env.HOST || '127.0.0.1',
    mongoUri: env.MONGODB_URI,
    dbName: env.MONGODB_DB || 'sandbee_gstin',
    secret: env.SESSION_SECRET,
    trustProxy: env.TRUST_PROXY === '1' ? 1 : false,
    cookieName: production ? '__Host-sandbee_session' : 'sandbee_session',
    sessionMs: 7 * 24 * 60 * 60 * 1000,
    apiLimit: 60,
    authLimit: 15,
    cacheMax: 10000,
    mail: {
      host: gmailUser ? 'smtp.gmail.com' : env.SMTP_HOST || '',
      port: gmailUser ? 465 : Number(env.SMTP_PORT || 1025),
      user: gmailUser,
      password: gmailPassword,
      from: env.MAIL_FROM || gmailUser || 'no-reply@sandbee.local',
    },
  };
}
module.exports = { readConfig };
