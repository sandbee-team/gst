'use strict';
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const root = path.resolve(__dirname, '..');
class OcrWorker {
  constructor({ python, timeoutMs = 10000, startupTimeoutMs = 30000, workerArgs } = {}) {
    const venv = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    this.python = python || process.env.GST_PYTHON || (existsSync(venv) ? venv : 'python');
    this.workerArgs = workerArgs || ['-u', path.join(root, 'captcha_ocr.py'), '--worker'];
    this.timeoutMs = timeoutMs; this.startupTimeoutMs = startupTimeoutMs;
    this.sequence = 0; this.state = null;
  }
  start() {
    if (this.state) return this.state.ready;
    const state = { jobs: new Map(), diagnostic: '', stopped: false };
    this.state = state;
    state.ready = new Promise((resolve, reject) => {
      state.rejectReady = reject;
      const child = state.child = spawn(this.python, this.workerArgs, {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
      state.timer = setTimeout(() => this.stop(state, new Error('OCR startup timed out.')), this.startupTimeoutMs);
      child.stderr.on('data', chunk => { state.diagnostic = (state.diagnostic + chunk).slice(-2000); });
      child.on('error', () => this.stop(state, new Error('Cannot start Python. Run the OCR setup commands in README.md.')));
      child.stdin.on('error', () => this.stop(state, new Error('OCR worker input closed.')));
      child.on('close', () => this.stop(state, new Error(`OCR worker stopped. ${state.diagnostic.trim()}`)));
      state.lines = readline.createInterface({ input: child.stdout });
      state.lines.on('line', line => {
        if (state.stopped) return;
        let message;
        try { message = JSON.parse(line); } catch { this.stop(state, new Error('OCR worker returned invalid JSON.')); return; }
        if (!message || typeof message !== 'object') { this.stop(state, new Error('Invalid OCR worker response.')); return; }
        if (message.ready === true) { clearTimeout(state.timer); resolve(state); return; }
        const job = state.jobs.get(message.id);
        if (!job) return;
        clearTimeout(job.timer); state.jobs.delete(message.id);
        if (message.error) job.reject(new Error(message.error));
        else if (!message.result || typeof message.result.text !== 'string' || !Number.isFinite(message.result.score)
          || typeof message.result.autoSubmit !== 'boolean') job.reject(new Error('Invalid OCR result.'));
        else job.resolve(message.result);
      });
    });
    return state.ready;
  }
  async solve(buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 2 * 1024 * 1024) throw new Error('Invalid OCR image size.');
    const state = await this.start();
    if (state.stopped) throw new Error('OCR worker stopped.');
    if (state.jobs.size >= 4) throw new Error('OCR worker is busy.');
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => this.stop(state, new Error('OCR timed out.')), this.timeoutMs);
      state.jobs.set(id, { resolve, reject, timer });
      state.child.stdin.write(JSON.stringify({ id, image: buffer.toString('base64') }) + '\n');
    });
  }
  stop(state, error) {
    if (state.stopped) return;
    state.stopped = true;
    clearTimeout(state.timer);
    state.rejectReady(error);
    for (const job of state.jobs.values()) { clearTimeout(job.timer); job.reject(error); }
    state.jobs.clear(); state.lines?.close(); state.child?.kill();
    if (this.state === state) this.state = null;
  }
  close() { if (this.state) this.stop(this.state, new Error('OCR worker closed.')); }
}
module.exports = { OcrWorker };
