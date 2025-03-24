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

## 起動方法

```
npm start
```

## ブラウザの設定

お使いのブラウザのプロキシ設定で、HTTPおよびHTTPSプロキシとして `localhost:8000`（または設定したポート）を指定してください。

## 必要な環境

- Node.js 20.10.0以上

## ライセンス

MIT