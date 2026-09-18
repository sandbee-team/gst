'use strict';
require('dotenv').config({ quiet: true });
const { readConfig } = require('./backend/config');
const { connectDatabase } = require('./backend/database');
const { createApp } = require('./backend/app');
const { GstClient } = require('./lib/gst-client');
const { OcrWorker } = require('./lib/ocr-worker');
const { lookup } = require('./lib/lookup');
async function main() {
  const config = readConfig();
  const { client: database, db } = await connectDatabase(config);
  const solver = new OcrWorker(),
    client = new GstClient();
  const app = createApp({ db, config, liveLookup: (gstin) => lookup(gstin, { client, solver }) });
  const server = app.listen(config.port, config.host, () =>
    console.log(`GSTIN by sandbee listening on ${config.appUrl}`),
  );
  solver
    .start()
    .then(() => console.log('OCR ready'))
    .catch(() => console.warn('OCR warmup failed; next lookup will retry.'));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 15000);
    deadline.unref();
    server.close(async () => {
      solver.close();
      await Promise.allSettled(app.locals.otp.deliveries);
      await database.close();
      clearTimeout(deadline);
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
if (require.main === module)
  main().catch((error) => {
    console.error(`Startup failed: ${error.name}. Check configuration and database connectivity.`);
    process.exitCode = 1;
  });
module.exports = { main };
