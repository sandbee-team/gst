'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { GstClient, CAPTCHA_PATTERN } = require('./lib/gst-client');
const { OcrWorker } = require('./lib/ocr-worker');
const { lookup } = require('./lib/lookup');

async function main() {
  const args = process.argv.slice(2);
  if (!args[0] || args.includes('--help')) {
    console.log('Usage: node gst-cli.js <GSTIN> [--manual] [--no-prompt]');
    return;
  }
  if (args.slice(1).some(a => !['--manual', '--no-prompt'].includes(a))) throw new Error('Unknown option. Use --help.');
  const client = new GstClient(), solver = new OcrWorker();
  let folder;
  try {
    const result = await lookup(args[0], { client, solver, manual: args.includes('--manual'), onProgress: console.error });
    if (result.status === 'success') { console.log(JSON.stringify(result, null, 2)); return; }
    if (args.includes('--no-prompt') || !process.stdin.isTTY) {
      console.log(JSON.stringify({ status: result.status, reason: result.reason, prediction: result.prediction }, null, 2));
      process.exitCode = 2; return;
    }
    folder = await fs.mkdtemp(path.join(os.tmpdir(), '.gst-captcha-'));
    const imagePath = path.join(folder, 'captcha.png');
    await fs.writeFile(imagePath, result.challenge.buffer);
    console.error(`${result.reason}\nOpen image: ${imagePath}`);
    if (result.prediction?.text) console.error(`OCR suggestion: ${result.prediction.text}`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    let captcha;
    try { captcha = (await rl.question('CAPTCHA (6 digits): ')).trim(); } finally { rl.close(); }
    if (!CAPTCHA_PATTERN.test(captcha)) throw new Error('CAPTCHA must contain exactly six digits.');
    const details = await client.getDetails(result.gstin, captcha, result.challenge);
    console.log(JSON.stringify({ status: 'success', details }, null, 2));
  } finally {
    solver.close();
    if (folder) await fs.rm(folder, { recursive: true, force: true });
  }
}
if (require.main === module) main().catch(error => { console.error(`${error.code || 'ERROR'}: ${error.message}`); process.exitCode = 1; });
module.exports = { main };
