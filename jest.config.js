module.exports = {
  // テストを並列ではなく順番に実行する（--runInBandが指定される場合はこれは無視される）
  // --maxWorkersとの競合を避けるためにコメントアウト
  // runInBand: true,
  
  // テスト実行順序を明示的に制御
  testSequencer: './jest.sequencer.js',
  
  // タイムアウトを60秒に延長
  testTimeout: 60000,
  
  // 各テストファイル間に少し待機時間を入れる
  slowTestThreshold: 10,
  
  // 環境変数の設定
  testEnvironment: 'node',
  
  // テスト実行前のスクリプト
  setupFilesAfterEnv: ['./jest.setup.js'],
  
  // テストの最大同時実行数を指定しない（package.jsonで指定する）
  // maxWorkers: 1,
  
  // JestでサポートされていないglobalTimeoutオプションを削除
  // globalTimeout: 300000,
  
  // 個々のテストファイルの実行制限時間を3分に設定
  testTimeout: 180000,
  
  // テスト失敗時のコンソール出力制限を無効化
  verbose: true,
};
