const fs = require('fs');
const path = require('path');

/**
 * API エンドポイントハンドラー
 */
class ApiEndpoints {
    /**
     * コンストラクタ
     * @param {Object} options 設定オブジェクト
     * @param {Object} options.logger ロガー
     * @param {Object} options.statsCollector 統計情報収集器
     * @param {Object} options.whitelistManager ホワイトリストマネージャー
     * @param {Object} options.cacheManager キャッシュマネージャー
     * @param {string} options.cacheDir キャッシュディレクトリのパス
     */
    constructor(options) {
        this.logger = options.logger;
        this.statsCollector = options.statsCollector;
        this.whitelistManager = options.whitelistManager;
        this.cacheManager = options.cacheManager;
        this.cacheDir = options.cacheDir;
        this.directHttpsRequest = options.directHttpsRequest;
    }

    /**
     * リクエストハンドラー
     * @param {http.IncomingMessage} req リクエストオブジェクト
     * @param {http.ServerResponse} res レスポンスオブジェクト
     * @returns {boolean} 処理したかどうか
     */
    handleRequest(req, res) {
        // すでに処理されているレスポンスは無視
        if (res.headersSent || res.writableEnded) {
            return false;
        }
        
        // 統計情報のAPIエンドポイント
        if (this.handleStats(req, res)) return true;
        
        // ヘルスチェックAPI
        if (this.handleHealthCheck(req, res)) return true;
        
        // ホワイトリスト確認API
        if (this.handleWhitelistCheck(req, res)) return true;
        
        // キャッシュクリア
        if (this.handleCacheClear(req, res)) return true;
        
        // キャッシュチェック
        if (this.handleCacheCheck(req, res)) return true;
        
        // キャッシュ更新
        if (this.handleCacheUpdate(req, res)) return true;
        
        // メインページ
        if (this.handleMainPage(req, res)) return true;
        
        return false;
    }
    
    /**
     * 統計情報API
     */
    handleStats(req, res) {
        if (req.url === '/proxy-stats' && req.headers.host.includes('localhost')) {
            res.writeHead(200, {'Content-Type': 'application/json'});
            
            // 統計データを取得
            const rawStats = this.statsCollector.getStats();
            
            // テスト互換性のために形式を調整
            const statsData = {
                stats: {
                    requests: rawStats.http.requests,  // テストケースが期待するプロパティ名
                    httpRequests: rawStats.http.requests, // 追加のプロパティとして保持
                    httpsRequests: rawStats.https.requests, 
                    cacheHits: rawStats.http.cacheHits,
                    cacheMisses: rawStats.http.cacheMisses
                },
                httpsStats: {
                    connections: rawStats.https.connections,
                    cacheHits: rawStats.https.cacheHits,
                    cacheMisses: rawStats.https.cacheMisses,
                    cacheSaves: rawStats.https.cacheSaves
                },
                activeConnections: rawStats.activeConnections,
                timestamp: rawStats.timestamp,
                uptime: rawStats.uptime,
                memoryUsage: rawStats.memoryUsage,
                whitelistedDomains: this.whitelistManager.getAllDomains(),
                whitelistedRegexPatterns: this.whitelistManager.getAllRegexPatterns()
            };
            
            res.end(JSON.stringify(statsData, null, 2));
            return true;
        }
        return false;
    }
    
    /**
     * ヘルスチェックAPI
     */
    handleHealthCheck(req, res) {
        if (req.url === '/health' && req.headers.host.includes('localhost')) {
            res.writeHead(200, {'Content-Type': 'text/plain'});
            res.end('OK');
            return true;
        }
        return false;
    }
    
    /**
     * ホワイトリスト確認API
     */
    handleWhitelistCheck(req, res) {
        if (req.url === '/check-whitelist' && req.headers.host.includes('localhost')) {
            const host = req.headers['x-check-host'];
            if (host) {
                const isWhitelisted = this.whitelistManager.isHostWhitelisted(host);
                
                // どのルールでマッチしたか確認
                let matchedBy = 'none';
                if (this.whitelistManager.domains.has(host)) {
                    matchedBy = 'exact';
                } else {
                    for (const regex of this.whitelistManager.regexPatterns) {
                        if (regex.test(host)) {
                            matchedBy = regex.toString();
                            break;
                        }
                    }
                }
                
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({
                    host,
                    isWhitelisted,
                    matchedBy,
                    whitelistedDomains: this.whitelistManager.getAllDomains(),
                    whitelistedRegexPatterns: this.whitelistManager.getAllRegexPatterns()
                }));
            } else {
                res.writeHead(400, {'Content-Type': 'text/plain'});
                res.end('X-Check-Host header is required');
            }
            return true;
        }
        return false;
    }
    
    /**
     * キャッシュクリアAPI
     */
    handleCacheClear(req, res) {
        if (req.url === '/clear-cache' && req.headers.host.includes('localhost')) {
            fs.readdir(this.cacheDir, (err, files) => {
                if (err) {
                    res.writeHead(500, {'Content-Type': 'text/plain'});
                    res.end(`キャッシュディレクトリ読み取りエラー: ${err.message}`);
                    return;
                }
                
                let deleted = 0;
                const errors = [];
                
                if (files.length === 0) {
                    res.writeHead(200, {'Content-Type': 'text/plain'});
                    res.end('キャッシュファイルはありません');
                    return;
                }
                
                files.forEach(file => {
                    try {
                        fs.unlinkSync(path.join(this.cacheDir, file));
                        deleted++;
                    } catch (unlinkErr) {
                        errors.push(`${file}: ${unlinkErr.message}`);
                    }
                });
                
                res.writeHead(200, {'Content-Type': 'text/plain'});
                res.end(`${deleted}個のキャッシュファイルを削除しました。${errors.length > 0 ? `\nエラー: ${errors.join(', ')}` : ''}`);
            });
            return true;
        }
        return false;
    }
    
    /**
     * キャッシュチェックAPI
     */
    handleCacheCheck(req, res) {
        if (req.url.startsWith('/check-cache') && req.headers.host.includes('localhost')) {
            const urlParam = new URL(`http://localhost${req.url}`).searchParams.get('url');
            if (!urlParam) {
                res.writeHead(400, {'Content-Type': 'text/plain'});
                res.end('url parameter is required');
                return true;
            }
            
            const cacheFile = this.cacheManager.getCacheFileName(urlParam);
            fs.access(`${cacheFile}.cache`, fs.constants.F_OK, (err) => {
                if (err) {
                    res.writeHead(200, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({
                        cached: false,
                        url: urlParam,
                        message: 'Cache not found'
                    }));
                    return;
                }
                
                this.cacheManager.loadCache(cacheFile)
                    .then(cache => {
                        res.writeHead(200, {'Content-Type': 'application/json'});
                        if (cache) {
                            res.end(JSON.stringify({
                                cached: true,
                                url: urlParam,
                                statusCode: cache.statusCode,
                                contentType: cache.headers['content-type'],
                                dataSize: cache.data ? Buffer.from(cache.data, 'base64').length : 'unknown'
                            }));
                        } else {
                            res.end(JSON.stringify({
                                cached: false,
                                url: urlParam,
                                message: 'Invalid cache data'
                            }));
                        }
                    })
                    .catch(error => {
                        res.writeHead(500, {'Content-Type': 'application/json'});
                        res.end(JSON.stringify({
                            error: error.message,
                            url: urlParam
                        }));
                    });
            });
            return true;
        }
        return false;
    }
    
    /**
     * キャッシュ更新API
     */
    handleCacheUpdate(req, res) {
        if (req.url.startsWith('/update-cache') && req.headers.host.includes('localhost')) {
            const urlParam = new URL(`http://localhost${req.url}`).searchParams.get('url');
            if (!urlParam) {
                res.writeHead(400, {'Content-Type': 'text/plain'});
                res.end('url parameter is required');
                return true;
            }
            
            this.directHttpsRequest(urlParam)
                .then(response => {
                    res.writeHead(200, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({
                        success: true,
                        url: urlParam,
                        statusCode: response.statusCode,
                        contentType: response.headers['content-type'],
                        dataSize: response.data.length,
                        fromCache: response.fromCache
                    }));
                })
                .catch(error => {
                    res.writeHead(500, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({
                        error: error.message,
                        url: urlParam
                    }));
                });
            return true;
        }
        return false;
    }
    
    /**
     * メインページ表示
     */
    handleMainPage(req, res) {
        if (req.url === '/' && req.headers.host.includes('localhost')) {
            res.writeHead(200, {'Content-Type': 'text/html'});
            const stats = this.statsCollector.getStats();
            res.end(`
                <html>
                <head>
                    <title>プロキシキャッシュサーバー</title>
                    <style>
                        body { font-family: Arial, sans-serif; margin: 20px; }
                        h1 { color: #333; }
                        .card { border: 1px solid #ddd; padding: 15px; margin-bottom: 15px; border-radius: 5px; }
                        pre { background: #f5f5f5; padding: 10px; border-radius: 5px; }
                        .stats { display: flex; gap: 20px; }
                        .stat-box { flex: 1; background: #f0f0f0; padding: 10px; border-radius: 5px; }
                        input[type="text"] { width: 80%; padding: 5px; }
                        button { padding: 5px 10px; }
                    </style>
                </head>
                <body>
                    <h1>プロキシキャッシュサーバー</h1>
                    <div class="card">
                        <h2>統計情報</h2>
                        <div class="stats">
                            <div class="stat-box">
                                <h3>HTTP</h3>
                                <p>リクエスト: ${stats.http.requests}</p>
                                <p>キャッシュヒット: ${stats.http.cacheHits}</p>
                                <p>キャッシュミス: ${stats.http.cacheMisses}</p>
                            </div>
                            <div class="stat-box">
                                <h3>HTTPS</h3>
                                <p>リクエスト: ${stats.https.requests}</p>
                                <p>キャッシュヒット: ${stats.https.cacheHits}</p>
                                <p>キャッシュミス: ${stats.https.cacheMisses}</p>
                                <p>キャッシュ保存: ${stats.https.cacheSaves}</p>
                            </div>
                            <div class="stat-box">
                                <h3>接続情報</h3>
                                <p>アクティブ接続: ${stats.activeConnections}</p>
                                <p>稼働時間: ${Math.floor(stats.uptime / 60)} 分</p>
                            </div>
                        </div>
                    </div>
                    
                    <!-- 他のHTMLコンテンツはそのまま -->
                    <div class="card">
                        <h2>キャッシュテスト</h2>
                        <div>
                            <input type="text" id="testUrl" placeholder="https://example.com/" value="https://example.com/">
                            <button onclick="checkCache()">キャッシュ確認</button>
                            <button onclick="updateCache()">キャッシュ更新</button>
                        </div>
                        <pre id="result">結果がここに表示されます</pre>
                    </div>
                    
                    <div class="card">
                        <h2>ホワイトリスト</h2>
                        <h3>完全一致ドメイン:</h3>
                        <ul>
                            ${this.whitelistManager.getAllDomains().map(domain => `<li>${domain}</li>`).join('')}
                        </ul>
                        <h3>正規表現パターン:</h3>
                        <ul>
                            ${this.whitelistManager.getAllRegexPatterns().map(regex => `<li>${regex}</li>`).join('')}
                        </ul>
                    </div>
                    
                    <div class="card">
                        <h2>ホワイトリストチェック</h2>
                        <div>
                            <input type="text" id="checkHost" placeholder="example.com" value="">
                            <button onclick="checkWhitelist()">ホワイトリスト確認</button>
                        </div>
                        <pre id="whitelistResult">結果がここに表示されます</pre>
                    </div>
                    
                    <div class="card">
                        <h2>管理</h2>
                        <p><a href="/clear-cache">キャッシュをクリア</a></p>
                        <p><a href="/proxy-stats">JSONで統計情報を表示</a></p>
                        <p><a href="/health">ヘルスチェック</a></p>
                    </div>
                    
                    <script>
                        // JavaScriptコード部分はそのまま
                        async function checkCache() {
                            const url = document.getElementById('testUrl').value;
                            const result = document.getElementById('result');
                            result.textContent = 'Loading...';
                            
                            try {
                                const response = await fetch('/check-cache?url=' + encodeURIComponent(url));
                                const data = await response.json();
                                result.textContent = JSON.stringify(data, null, 2);
                            } catch (err) {
                                result.textContent = 'Error: ' + err.message;
                            }
                        }
                        
                        async function updateCache() {
                            const url = document.getElementById('testUrl').value;
                            const result = document.getElementById('result');
                            result.textContent = 'Updating...';
                            
                            try {
                                const response = await fetch('/update-cache?url=' + encodeURIComponent(url));
                                const data = await response.json();
                                result.textContent = JSON.stringify(data, null, 2);
                            } catch (err) {
                                result.textContent = 'Error: ' + err.message;
                            }
                        }
                        
                        async function checkWhitelist() {
                            const host = document.getElementById('checkHost').value;
                            const result = document.getElementById('whitelistResult');
                            result.textContent = 'Checking...';
                            
                            try {
                                const response = await fetch('/check-whitelist', {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json',
                                        'X-Check-Host': host
                                    }
                                });
                                const data = await response.json();
                                result.textContent = JSON.stringify(data, null, 2);
                            } catch (err) {
                                result.textContent = 'Error: ' + err.message;
                            }
                        }
                    </script>
                </body>
                </html>
            `);
            return true;
        } else if (req.headers.host.includes('localhost:8000')) {
            // ローカルホストへの直接リクエストを拒否
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('直接のローカルホストへのリクエストは許可されていません');
            return true;
        }
        return false;
    }
}

module.exports = ApiEndpoints;
