# CachingEdgeProxy 技術仕様書

## 概要

CachingEdgeProxyは、インターネット接続を高速化するためのキャッシュ機能付きプロキシサーバーです。一度アクセスしたウェブサイトのコンテンツをローカルに保存（キャッシュ）し、次回以降のアクセスを高速化します。Node.jsで実装されており、HTTPとHTTPSの両方のプロトコルに対応しています。

## 主な機能

1. **HTTPとHTTPSのプロキシ**: 通常のウェブページ（HTTP）と暗号化されたウェブページ（HTTPS）の両方に対応
2. **スマートキャッシュ**: あらかじめ設定したウェブサイトの内容をキャッシュ（MD5ハッシュを用いたキー管理）
3. **ホワイトリスト機能**: 正規表現にも対応したホワイトリスト設定によるキャッシュ対象ドメインの指定
4. **証明書管理**: HTTPSサイトへの接続に必要なTLS証明書を自動生成・管理
5. **クエリパラメータに対応したキャッシュ**: URLのクエリパラメータも含めた完全なキャッシュ
6. **接続の効率化**: Keep-Aliveやパイプライン処理によるパフォーマンスの最適化
7. **エラーハンドリング**: 様々な接続エラーに対応した堅牢なエラー処理
8. **柔軟なロギング設定**: 異なる詳細レベルでの診断とトラブルシューティング

## 技術アーキテクチャ

### 1. プロキシサーバーの実装

Node.jsの標準ライブラリ（`http`, `https`, `net`, `tls`）を活用した非同期イベント駆動型プロキシサーバー。`http.createServer()`と`net.connect()`を組み合わせて、HTTP(S)リクエストの中継と処理を実装しています。

### 2. キャッシュシステム

ファイルシステムベースのキャッシュを実装しており、URLごとにMD5ハッシュを生成してユニークなキャッシュファイルを作成します。キャッシュデータはJSONフォーマットのメタデータファイルと実際のコンテンツファイルに分けて保存され、効率的な管理と読み込みを実現しています。

### 3. ホワイトリスト機能

設定ファイルで指定されたドメイン名を文字列完全一致または正規表現パターンでチェックし、キャッシュ対象を限定します。正規表現パターンは`regex:`プレフィックスで区別されます。

### 4. HTTP/HTTPS対応

- **HTTP**: 標準的なプロキシ処理で、リクエストとレスポンスの中継を行います。
- **HTTPS**: CONNECTメソッドのハンドリングとTLSトンネリングを実装。オプションでMITM（Man-in-the-Middle）方式のTLS終端処理によりHTTPSコンテンツもキャッシュ可能です。

### 5. ロギングシステム

複数のログレベルを持つ階層化されたロギングシステムを実装し、運用環境に応じた適切な詳細度での出力をサポートしています。

#### ログレベル定義

```javascript
const LOG_LEVEL = {
    ERROR: 0, // エラーメッセージのみ
    WARN: 1,  // 警告とエラー
    INFO: 2,  // 情報、警告、エラー
    DEBUG: 3  // 詳細なデバッグ情報を含むすべてのメッセージ
};
```

#### ログレベル設定メカニズム

1. **コマンドライン引数**: `--log-level=` パラメータを使用して設定可能
   ```
   node src/index.js --log-level=DEBUG
   ```
   数値での指定も可能: `--log-level=3`

2. **環境変数**: `LOG_LEVEL` 環境変数を使用して設定可能
   ```
   LOG_LEVEL=INFO node src/index.js
   ```

3. **優先順位**: コマンドライン引数 > 環境変数 > デフォルト値(ERROR)

4. **カスタムロガー関数**:
   ```javascript
   const logger = {
       error: (message, ...args) => { /* レベル0以上で表示 */ },
       warn: (message, ...args) => { /* レベル1以上で表示 */ },
       info: (message, ...args) => { /* レベル2以上で表示 */ },
       debug: (message, ...args) => { /* レベル3以上で表示 */ },
       log: (message, ...args) => { /* 常に表示 */ }
   };
   ```

## ソースコード構成と主要クラス/関数

### index.js

プログラムのエントリーポイントとメインロジックを含むファイルです。

#### 主要コンポーネント:

1. **サーバー初期化**
   - `http.createServer()`: HTTPプロキシサーバーのインスタンス生成
   - `server.on('connect')`: HTTPSトンネリングの処理
   - `initializeCacheDir()`: キャッシュディレクトリの初期化
   - `getLogLevel()`: コマンドライン引数または環境変数からログレベルを取得

2. **リクエスト処理**
   - `handleProxyRequest()`: リクエスト転送と処理
   - `setupHttpsResponseCapture()`: HTTPSレスポンスのキャプチャとキャッシュ
   - `directHttpsRequest()`: 直接HTTPSリクエストの実行

3. **キャッシュ管理**
   - `getCacheFileName()`: キャッシュファイル名の生成（URLからMD5ハッシュ）
   - `loadCache()`: キャッシュからのデータロード
   - `saveCache()`: キャッシュへのデータ保存
   - `checkAndRepairCacheFile()`: 破損キャッシュファイルの検出と修復

4. **その他のユーティリティ**
   - `isHostWhitelisted()`: ホワイトリストチェック
   - `normalizeUrl()`: URL正規化
   - `prefetchDomainContent()`: ドメインコンテンツの事前キャッシュ
   - `cleanup()`: アプリケーション終了時のクリーンアップ処理

### certificates.js

HTTPS接続に必要なTLS証明書を管理するクラスを実装しています。

#### 主な機能:

```javascript
class CertificateManager {
  constructor(config) { /* 設定の初期化 */ }
  async initialize() { /* 証明書の初期化・生成 */ }
  generateCertificate() { /* 新規証明書の生成 */ }
  getCertificate() { /* 証明書の取得 */ }
  getPrivateKey() { /* 秘密鍵の取得 */ }
}
```

- **証明書生成**: OpenSSL相当の機能をNode.js内で実装し、自己署名証明書を生成
- **証明書と鍵の管理**: ファイルシステムでの保存と読み込み

### テスト実装

#### e2e/proxy.curl.test.js

実際のネットワークリクエストを使用したEnd-to-Endテストを実装。

- `curl`コマンドをJestテストフレームワークから実行
- HTTP/HTTPSリクエストのプロキシング検証
- キャッシュヒット/ミスの確認
- エラー処理のテスト

#### certificates.test.js

証明書管理クラスの単体テスト。

- 証明書生成のテスト
- ファイル操作の検証
- エラー処理の確認

## データフロー
クライアント → [HTTP(S)リクエスト] → CachingEdgeProxy
  ↓
ホワイトリストチェック
  ↓
キャッシュチェック → [キャッシュヒット] → クライアントへレスポンス
  ↓ [キャッシュミス]
対象サーバーへリクエスト転送
  ↓
レスポンス受信
  ↓
ホワイトリスト対象の場合はキャッシュに保存
  ↓
クライアントへレスポンス転送

## 重要な実装詳細
非同期処理: Node.jsのPromiseとasync/await構文を使用した非同期処理
ストリーム処理: データの効率的な転送のためのストリームパイプライン
エラー処理: try-catchブロックとイベントリスナーによる包括的なエラーハンドリング
TLSの処理: 証明書管理とTLSソケット操作（自己署名証明書の生成・検証スキップ）
リソース管理: ソケットのクリーンアップとタイムアウト処理による安定性の向上
デバッグ機能: 複数レベルのロギングによるトラブルシューティングサポート

## 設定ファイル構造
```
{
  "proxyPort": 8000,
  "whitelistedDomains": [
    "example.com",
    "regex:^.*\\.mydomain\\.com$"
  ],
  "https": {
    "certPath": "path/to/certificate.crt",
    "keyPath": "path/to/private.key"
  }
}
```
## パフォーマンス最適化
1. バッファプーリング: メモリ使用量の最適化
2. 接続管理: Keep-Aliveとコネクションプーリング
3. 選択的キャッシュ: 重要なドメインのみをキャッシュしてストレージ効率化
4. エッジケースハンドリング: 様々なネットワーク状況や不安定な接続に対応

## セキュリティの考慮事項
1. TLS証明書管理: 自己署名証明書の安全な生成と保存
2. ホワイトリスト: 信頼できるドメインのみをキャッシュ
3. コネクション管理: タイムアウトと適切なソケットクローズによる資源枯渇防止
4. 入力検証: URLと受信データの適切な検証によるインジェクション防止

## コンフィギュレーションオプション

### ログレベル設定

プロキシサーバーの詳細レベルは複数の方法で設定可能です。

1. **コマンドライン引数**:
   ```
   node src/index.js --log-level=[ERROR|WARN|INFO|DEBUG]
   ```
   または数値で指定:
   ```
   node src/index.js --log-level=[0|1|2|3]
   ```

2. **環境変数**:
   ```
   LOG_LEVEL=INFO node src/index.js
   ```

3. **使用シナリオ別推奨設定**:
   - 運用環境: `ERROR` または `WARN` - 重要なメッセージのみ表示
   - テスト環境: `INFO` - 主要な操作に関する情報を表示
   - 開発環境: `DEBUG` - すべての詳細情報を表示
   - トラブルシューティング: `DEBUG` - 問題解決のための詳細なデバッグ情報

4. **出力内容**:
   - `ERROR`: 重大なエラーのみ（接続失敗、システム問題など）
   - `WARN`: 警告（破損キャッシュ、リトライなど）+ エラー
   - `INFO`: 操作の進行状況（リクエスト受信、キャッシュヒット/ミスなど）+ 警告 + エラー
   - `DEBUG`: すべての詳細（HTTP処理、ヘッダー解析、バッファ操作など）

### ポート設定

プロキシサーバーがリッスンするポート番号は複数の方法で設定可能です。

1. **コマンドライン引数**:
   ```
   node src/index.js --port=8080
   ```

2. **環境変数**:
   ```
   PORT=8080 node src/index.js
   ```
   または
   ```
   export PORT=8080
   node src/index.js
   ```

3. **設定ファイル**:
   `config/proxy-config.json`内の`proxyPort`値で指定

4. **優先順位**:
   - コマンドライン引数 (`--port=8080`)
   - 環境変数 (`PORT=8080`)
   - 設定ファイル値
   - デフォルト値 (8000)

5. **利用シナリオ**:
   - 開発環境: コマンドライン引数を使用して複数のインスタンスを異なるポートで実行
   - コンテナ環境: 環境変数を使用してコンテナ化された環境でポートを設定
   - 本番環境: 設定ファイルで固定ポートを指定

## 運用管理用API

プロキシサーバーには、運用とモニタリングのための複数のHTTPエンドポイントが実装されています。これらのAPIは、プロキシサーバー自体に対してローカルホストからアクセスすることで利用できます。

### セキュリティ考慮事項

これらのエンドポイントはローカルホスト（`localhost`または`127.0.0.1`）からのアクセスのみを許可するよう制限されています。これはセキュリティ上の理由により、リモートホストからこれらのインターフェースにアクセスして、内部情報の取得やプロキシの動作を妨害することを防ぐためです。

### 1. ヘルスチェックAPI

**エンドポイント**: `GET /health`

**機能**: プロキシサーバーのヘルスステータスを確認するための単純なエンドポイント。

**レスポンスフォーマット**: テキスト
```
OK
```

**ステータスコード**:
- `200 OK`: サーバーが正常に動作している
- `500 Internal Server Error`: サーバーに問題がある場合

**実装詳細**:
```javascript
// サーバーのベーシックなヘルスチェックエンドポイント
server.on('request', (req, res) => {
  if (req.url === '/health' && req.headers.host.includes('localhost')) {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('OK');
    return;
  }
  // ...他のリクエスト処理
});
```

### 2. 統計情報API

**エンドポイント**: `GET /proxy-stats`

**機能**: プロキシサーバーの詳細な稼働統計情報を提供します。

**レスポンスフォーマット**: JSON
```json
{
  "stats": {
    "httpRequests": <number>,
    "httpsRequests": <number>,
    "cacheHits": <number>,
    "cacheMisses": <number>
  },
  "httpsStats": {
    "connections": <number>,
    "cacheHits": <number>,
    "cacheMisses": <number>,
    "cacheSaves": <number>
  },
  "whitelistedDomains": [<string>, ...],
  "whitelistedRegexPatterns": [<string>, ...],
  "activeConnections": <number>,
  "uptime": <number>,
  "memoryUsage": {
    "rss": <number>,
    "heapTotal": <number>,
    "heapUsed": <number>,
    "external": <number>
  },
  "timestamp": <ISO8601 date string>
}
```

**統計フィールドの説明**:
- `stats.httpRequests`: 処理されたHTTPリクエストの総数
- `stats.httpsRequests`: 処理されたHTTPSリクエストの総数
- `stats.cacheHits`: キャッシュヒット数（HTTP）
- `stats.cacheMisses`: キャッシュミス数（HTTP）
- `httpsStats.connections`: HTTPSプロキシ接続の総数
- `httpsStats.cacheHits`: HTTPSキャッシュヒット数
- `httpsStats.cacheMisses`: HTTPSキャッシュミス数
- `httpsStats.cacheSaves`: キャッシュに保存されたHTTPSレスポンス数
- `whitelistedDomains`: ホワイトリストに登録されている完全一致ドメイン
- `whitelistedRegexPatterns`: ホワイトリストに登録されている正規表現パターン
- `activeConnections`: 現在アクティブなコネクション数
- `uptime`: サーバーの稼働時間（秒）
- `memoryUsage`: Node.jsプロセスのメモリ使用状況
- `timestamp`: 統計情報の収集時刻

**実装詳細**:
```javascript
// 統計情報APIエンドポイント
server.on('request', (req, res) => {
  if (req.url === '/proxy-stats' && req.headers.host.includes('localhost')) {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({
      stats,
      httpsStats,
      whitelistedDomains: Array.from(whitelistedDomains),
      whitelistedRegexPatterns: whitelistedRegexPatterns.map(r => r.toString()),
      activeConnections: activeConnections.size,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      timestamp: new Date().toISOString()
    }, null, 2));
    return;
  }
  // ...他のリクエスト処理
});
```

### 3. ホワイトリスト確認API

**エンドポイント**: `POST /check-whitelist`

**ヘッダー**: `X-Check-Host: <ホスト名>`

**機能**: 指定されたホスト名がホワイトリストに含まれているかを確認します。

**レスポンスフォーマット**: JSON
```json
{
  "host": "<チェックされたホスト名>",
  "isWhitelisted": true|false,
  "matchedBy": "<マッチしたルール>",
  "whitelistedDomains": ["<ドメイン1>", "<ドメイン2>", ...],
  "whitelistedRegexPatterns": ["<パターン1>", "<パターン2>", ...]
}
```

**実装詳細**:
```javascript
// ホワイトリスト確認API
server.on('request', (req, res) => {
  if (req.url === '/check-whitelist' && req.headers.host.includes('localhost')) {
    const host = req.headers['x-check-host'];
    if (host) {
      const isWhitelisted = isHostWhitelisted(host);
      // マッチ情報を収集して応答
      // ...
    } else {
      res.writeHead(400, {'Content-Type': 'text/plain'});
      res.end('X-Check-Host header is required');
    }
    return;
  }
  // ...他のリクエスト処理
});
```

### 4. キャッシュクリアAPI

**エンドポイント**: `GET /clear-cache`

**機能**: キャッシュディレクトリ内のすべてのキャッシュファイルを削除します。

**レスポンスフォーマット**: テキスト
```
<削除されたファイル数>個のキャッシュファイルを削除しました。[エラー: <エラーメッセージ>]
```

**実装詳細**:
```javascript
// キャッシュクリアAPI
server.on('request', (req, res) => {
  if (req.url === '/clear-cache' && req.headers.host.includes('localhost')) {
    fs.readdir(CACHE_DIR, (err, files) => {
      // ディレクトリ内のすべてのファイルを列挙して削除
      // ...
      res.writeHead(200, {'Content-Type': 'text/plain'});
      res.end(`${deleted}個のキャッシュファイルを削除しました。${errors.length > 0 ? `\nエラー: ${errors.join(', ')}` : ''}`);
    });
    return;
  }
  // ...他のリクエスト処理
});
```

### 5. メインダッシュボード

**エンドポイント**: `GET /`

**機能**: プロキシサーバーのステータスと操作用のHTML形式のダッシュボードを提供します。

**レスポンスフォーマット**: HTML

**機能**:
- プロキシの統計情報を表示
- キャッシュのテストと更新
- ホワイトリストのチェック
- キャッシュのクリア

**ダッシュボードの主要コンポーネント**:

1. **統計情報セクション**:
   - HTTP/HTTPSリクエスト数
   - キャッシュヒット/ミス数
   - 保存済みキャッシュ数

2. **キャッシュテストツール**:
   - URLを入力して既存のキャッシュを確認
   - キャッシュの強制更新が可能
   - テスト結果をJSON形式で表示

3. **ホワイトリスト表示**:
   - 完全一致ドメインのリスト
   - 正規表現パターンのリスト

4. **ホワイトリストチェッカー**:
   - ドメイン名を入力してホワイトリスト照合をテスト
   - マッチング結果とマッチしたルールを表示

5. **管理リンク**:
   - キャッシュクリア機能へのリンク
   - JSON形式の詳細統計情報へのリンク

**セキュリティ考慮事項**: ローカルホスト（`localhost`または`127.0.0.1`）からのアクセスのみを許可することで、リモートからの設定変更やシステム情報の漏洩を防止します。

**実装詳細**:
```javascript
// メインダッシュボード
server.on('request', (req, res) => {
  if (req.url === '/' && req.headers.host.includes('localhost')) {
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end(`
      <html>
        <head>
          <title>プロキシキャッシュサーバー</title>
          <style>/* CSS スタイリング */</style>
        </head>
        <body>
          <!-- ダッシュボードHTMLコンテンツ -->
          <h1>プロキシキャッシュサーバー</h1>
          
          <!-- 統計情報表示部分 -->
          <div class="card">
            <h2>統計情報</h2>
            <div class="stats">
              <div class="stat-box">
                <h3>HTTP</h3>
                <p>リクエスト: ${stats.httpRequests}</p>
                <p>キャッシュヒット: ${stats.cacheHits}</p>
                <p>キャッシュミス: ${stats.cacheMisses}</p>
              </div>
              <div class="stat-box">
                <h3>HTTPS</h3>
                <p>リクエスト: ${stats.httpsRequests}</p>
                <p>キャッシュヒット: ${httpsStats.cacheHits}</p>
                <p>キャッシュミス: ${httpsStats.cacheMisses}</p>
                <p>キャッシュ保存: ${httpsStats.cacheSaves}</p>
              </div>
            </div>
          </div>
          
          <!-- キャッシュテスト部分 -->
          <div class="card">
            <h2>キャッシュテスト</h2>
            <div>
              <input type="text" id="testUrl" placeholder="https://example.com/" value="https://example.com/">
              <button onclick="checkCache()">キャッシュ確認</button>
              <button onclick="updateCache()">キャッシュ更新</button>
            </div>
            <pre id="result">結果がここに表示されます</pre>
          </div>
          
          <!-- ホワイトリスト表示部分 -->
          <div class="card">
            <h2>ホワイトリスト</h2>
            <h3>完全一致ドメイン:</h3>
            <ul>
              ${Array.from(whitelistedDomains).map(domain => `<li>${domain}</li>`).join('')}
            </ul>
            <h3>正規表現パターン:</h3>
            <ul>
              ${whitelistedRegexPatterns.map(regex => `<li>${regex.toString()}</li>`).join('')}
            </ul>
          </div>
          
          <!-- ホワイトリストチェッカー部分 -->
          <div class="card">
            <h2>ホワイトリストチェック</h2>
            <div>
              <input type="text" id="checkHost" placeholder="example.com" value="">
              <button onclick="checkWhitelist()">ホワイトリスト確認</button>
            </div>
            <pre id="whitelistResult">結果がここに表示されます</pre>
          </div>
          
          <!-- 管理リンク部分 -->
          <div class="card">
            <h2>管理</h2>
            <p><a href="/clear-cache">キャッシュをクリア</a></p>
            <p><a href="/proxy-stats">JSONで統計情報を表示</a></p>
          </div>
          
          <!-- JavaScript機能 -->
          <script>
            // キャッシュ確認機能
            async function checkCache() {
              const url = document.getElementById('testUrl').value;
              // ...実装詳細...
            }
            
            // キャッシュ更新機能
            async function updateCache() {
              const url = document.getElementById('testUrl').value;
              // ...実装詳細...
            }
            
            // ホワイトリストチェック機能
            async function checkWhitelist() {
              const host = document.getElementById('checkHost').value;
              // ...実装詳細...
            }
          </script>
        </body>
      </html>
    `);
  }
  // ...他のリクエスト処理
});
```

**ユースケース**:

1. **開発とデバッグ**:
   - リアルタイムでのプロキシ統計情報の確認
   - キャッシュの動作確認と問題特定

2. **運用監視**:
   - プロキシサーバーの動作状況の視覚的確認
   - キャッシュヒット率の監視によるパフォーマンス評価

3. **トラブルシューティング**:
   - 特定のURLがキャッシュされているかの確認
   - ホワイトリスト設定の検証
   - キャッシュのリセット

4. **設定検証**:
   - 現在有効なホワイトリスト設定の確認
   - ドメインがホワイトリストに含まれるかのテスト

このダッシュボードはプロキシサーバーのシンプルな管理インターフェースとして機能し、コマンドラインを使わずに基本的な操作と監視を行うことができます。設計上、セキュリティ考慮によりローカルホストからのアクセスのみに制限されています。

## まとめ
CachingEdgeProxyは、Node.jsの非同期イベント駆動モデルを活用した高性能なキャッシュプロキシサーバーです。
ファイルシステムベースのキャッシュとTLS終端によるHTTPSキャッシュを実装し、ホワイトリストによるドメイン制限機能を持っています。証明書の自動生成機能と堅牢なエラー処理により、安全性と安定性を両立させています。
柔軟なロギングシステムの実装により、様々な運用環境での診断やトラブルシューティングが容易になっています。
