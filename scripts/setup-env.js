'use strict';
const { randomBytes } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const target = path.join(__dirname, '..', '.env');
try {
  writeFileSync(target, `# Generated local Docker configuration. Never commit this file.\nSESSION_SECRET=${randomBytes(48).toString('hex')}\nMONGO_PASSWORD=${randomBytes(24).toString('hex')}\nDOMAIN=gstapi.sandbee.in\nGMAIL_USER=\nGMAIL_APP_PASSWORD=\nMAIL_FROM=\n`, { flag: 'wx', mode: 0o600 });
  console.log('Created .env with random local secrets. Run docker compose up -d --build.');
} catch (error) { if (error.code === 'EEXIST') console.log('.env already exists; kept your configuration unchanged.'); else throw error; }
