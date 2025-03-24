// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './src/e2e',
  timeout: 60000,
  use: {
    headless: true,
    // 各テストでプロキシを動的に設定するため、ここではデフォルト値を削除
    // proxy: {
    //   server: 'http://localhost:8000',
    // },
    launchOptions: {
      // 各テストでプロキシを動的に設定するため、ここではデフォルト値を削除
      // args: ['--proxy-server=http://localhost:8000']
    }
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
      },
    },
  ],
  reporter: [['html'], ['list']],
});
