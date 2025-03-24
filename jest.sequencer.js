const Sequencer = require('@jest/test-sequencer').default;

// テストファイルの実行順序を制御するカスタムシーケンサー
class CustomSequencer extends Sequencer {
  sort(tests) {
    // テストファイルを特定の順序で実行
    const testPathOrder = [
      'certificates.test.js', // 証明書のテストを最初に実行
      'index.test.js',        // メインのテストを次に実行
      'proxy.test.js',        // E2Eテストをそれから実行
      'proxy.curl.test.js',   // curlを使ったテストを最後に実行
    ];

    return tests.sort((a, b) => {
      // テスト実行順序を定義する
      const pathA = a.path;
      const pathB = b.path;
      
      const indexA = testPathOrder.findIndex(p => pathA.includes(p));
      const indexB = testPathOrder.findIndex(p => pathB.includes(p));
      
      // 優先順位が見つからない場合は順序を維持
      if (indexA === -1 && indexB === -1) return 0;
      if (indexA === -1) return 1;  // Aが優先順位なしの場合は後ろへ
      if (indexB === -1) return -1; // Bが優先順位なしの場合はAを先に
      
      // 優先順位に従って順序を返す
      return indexA - indexB;
    });
  }
}

module.exports = CustomSequencer;
