// グローバルタイムアウトを60秒に設定
jest.setTimeout(60000);

// テスト間の待機時間を定義
const DELAY_BEFORE_TEST = 1000;
const DELAY_AFTER_TEST = 2000;

// テスト開始前の待機
beforeEach(async () => {
  console.log('テスト開始前の待機...');
  await new Promise(resolve => setTimeout(resolve, DELAY_BEFORE_TEST));
});

// テスト終了後の待機（リソースクリーンアップのため）
afterEach(async () => {
  console.log('テスト終了後の待機...');
  await new Promise(resolve => setTimeout(resolve, DELAY_AFTER_TEST));
});

// テストファイル実行間の追加待機（ポート解放のため）
beforeAll(async () => {
  console.log('テストファイル実行前の待機...');
  await new Promise(resolve => setTimeout(resolve, 3000));
});

afterAll(async () => {
  console.log('テストファイル終了後の待機...');
  await new Promise(resolve => setTimeout(resolve, 5000));
});

// Jestがプロセスを強制終了する前にクリーンアップを確実に行う
process.on('SIGTERM', async () => {
  console.log('SIGTERMを受信しました。クリーンアップを実行...');
  await new Promise(resolve => setTimeout(resolve, 1000));
  process.exit(0);
});
