const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './test/browser',
  workers: 1,
  use: {
    browserName: 'chromium',
    channel: process.platform === 'win32' ? 'msedge' : undefined,
    headless: true,
  },
});
