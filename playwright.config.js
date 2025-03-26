// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * @see https://playwright.dev/docs/test-configuration
 */
module.exports = defineConfig({
  testDir: './src/__tests__',
  /* テストタイムアウトを60秒に設定 */
  timeout: 60000,
  expect: {
    /**
     * アサーションのタイムアウトを5秒に設定
     */
    timeout: 5000
  },
  /* テスト実行レポートの設定 */
  reporter: [
    ['html'],
    ['list']
  ],
  /* 同時実行数の設定 */
  fullyParallel: false,
  /* 1つのテストファイル内での並列実行の無効化 */
  workers: 1,
  /* プロジェクト設定 */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  /* テスト実行ディレクトリ */
  outputDir: 'test-results/',
  /* Global setup/teardown */
  globalSetup: './src/__tests__/global-setup.js',
  globalTeardown: './src/__tests__/global-teardown.js',
});
