# CachingEdgeProxy

CachingEdgeProxyは、HTTP/HTTPSリクエストに対応したプロキシキャッシュサーバです。Node.jsで実装されており、指定したドメインのリクエストをキャッシュすることで、アクセス速度を向上させます。

## 特徴

- HTTP/HTTPSプロキシサーバとして機能
- 指定したドメインのコンテンツをキャッシュ（ホワイトリスト機能）
- 正規表現によるホワイトリストドメインの指定
- キャッシュによる高速なレスポンス提供
- HTTPS対応のプロキシ機能

## 動作の仕組み

1. ブラウザからのHTTP/HTTPSリクエストをプロキシサーバが受け取ります
2. リクエストURLがホワイトリストに含まれているか確認します
3. ホワイトリストに含まれており、キャッシュが存在する場合はキャッシュからレスポンスを返します
4. キャッシュが存在しない場合、リクエストを送信し、レスポンスをキャッシュした上で返します
5. ホワイトリストに含まれていない場合は、通常のプロキシとして動作します

## インストール

```
npm install
```

## 設定

`config/proxy-config.json`ファイルでプロキシの設定を行います：

```json
{
    "whitelistedDomains": [
        "example.com",
        "regex:(.+)\\.example\\.com"
    ],
    "proxyPort": 8000,
    "https": {
        "certPath": "./certs/proxy-ca.crt",
        "keyPath": "./certs/proxy-ca.key",
        "enabled": true
    }
}
```

- `whitelistedDomains`: キャッシュするドメインのリスト（正規表現も使用可能）
- `proxyPort`: プロキシサーバのポート番号
- `https`: HTTPS対応の設定（証明書、秘密鍵のパス、有効/無効）

## ログレベルの設定

プロキシサーバーの出力詳細度は、以下のログレベルで調整できます：

- `ERROR`: エラーメッセージのみ表示（デフォルト）
- `WARN`: 警告とエラーを表示
- `INFO`: 情報、警告、エラーを表示
- `DEBUG`: デバッグ情報を含むすべてのメッセージを表示

ログレベルは以下の方法で設定できます：

### コマンドライン引数による設定

```
node src/index.js --log-level=INFO
```

または数値での指定も可能：

```
node src/index.js --log-level=2  # INFO レベル (0=ERROR, 1=WARN, 2=INFO, 3=DEBUG)
```

### 環境変数による設定

```
LOG_LEVEL=DEBUG npm start
```

または

```
export LOG_LEVEL=INFO
npm start
```

## ポートの設定

プロキシサーバーのポート番号は以下の方法で設定できます：

### コマンドライン引数による設定

```
node src/index.js --port=8080
```

### 環境変数による設定

```
PORT=8080 npm start
```

または

```
export PORT=8080
npm start
```

### 優先順位

1. コマンドライン引数 (`--port=8080`)
2. 環境変数 (`PORT=8080`)
3. 設定ファイル (`config/proxy-config.json`の`proxyPort`値)
4. デフォルト値 (8000)

## 起動方法

```
npm start
```

## コンテナの作成
```
docker compose up -d --build
```

## 統計情報・ヘルスチェック用API

CachingEdgeProxyは、監視やデバッグに使用できるAPIエンドポイントを提供しています。これらは、プロキシサーバー自体にアクセスすることで利用できます。

### ヘルスチェックAPI

```
GET http://localhost:8000/health
```

このエンドポイントはプロキシサーバーの稼働状況を確認するために使用できます。サーバーが正常に動作している場合は、ステータスコード`200`と`OK`というレスポンスを返します。監視システムやロードバランサーと統合する場合に便利です。

### 統計情報API

```
GET http://localhost:8000/proxy-stats
```

このエンドポイントはプロキシの詳細な統計情報をJSON形式で返します。以下の情報を含みます：

- HTTP/HTTPSリクエスト数
- キャッシュヒット/ミス回数
- アクティブな接続数
- ホワイトリストに登録されているドメイン
- メモリ使用量
- 稼働時間

例：

```json
{
  "stats": {
    "httpRequests": 120,
    "httpsRequests": 85,
    "cacheHits": 45,
    "cacheMisses": 160
  },
  "httpsStats": {
    "connections": 85,
    "cacheHits": 30,
    "cacheMisses": 55,
    "cacheSaves": 40
  },
  "whitelistedDomains": ["example.com", "cdn.example.org"],
  "whitelistedRegexPatterns": ["/^.*\\.example\\.com$/i"],
  "activeConnections": 3,
  "uptime": 1825.4,
  "memoryUsage": {
    "rss": 58642432,
    "heapTotal": 25395200,
    "heapUsed": 12657128,
    "external": 1684337
  },
  "timestamp": "2023-12-15T09:23:45.678Z"
}
```

### ホワイトリスト確認API

```
POST http://localhost:8000/check-whitelist
Headers: X-Check-Host: example.com
```

指定したホスト名がホワイトリストに含まれているかを確認します。ホワイトリスト照合のテストやデバッグに便利です。

### キャッシュクリアAPI

```
GET http://localhost:8000/clear-cache
```

このエンドポイントは、すべてのキャッシュファイルをクリアします。キャッシュをリセットしたい場合に使用します。

### メインダッシュボードAPI

```
GET http://localhost:8000/
```

このエンドポイントにブラウザからアクセスすると、プロキシサーバーの統計情報やキャッシュの状態を視覚的に確認できるHTML形式のダッシュボードが表示されます。以下の機能を提供します：

- HTTP/HTTPSリクエスト数とキャッシュヒット/ミス数の統計情報
- キャッシュの動作確認（テストURLの入力と検証）
- ホワイトリスト設定の確認
- ホワイトリストチェックツール（ドメインがホワイトリストに含まれるか確認）
- キャッシュクリア機能へのリンク
- JSON形式の詳細統計情報へのリンク

開発やトラブルシューティングの際に役立つツールです。このダッシュボードは管理目的のために設計されているため、`localhost`からのアクセスのみが許可されています。

## ブラウザの設定

お使いのブラウザのプロキシ設定で、HTTPおよびHTTPSプロキシとして `localhost:8000`（または設定したポート）を指定してください。

## 必要な環境

- Node.js 20.10.0以上

## ライセンス

MIT