const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const { URL } = require('url');
const CertificateManager = require('./certificates');
const { Logger, LOG_LEVEL } = require('./logger');
const WhitelistManager = require('./whitelist-manager');
const CacheManager = require('./cache-manager');
const StatisticsCollector = require('./statistics-collector');
const ApiEndpoints = require('./api-endpoints');

// ロガーのインスタンスを作成
const logger = new Logger(Logger.getLogLevelFromEnv());

// 設定ファイルの読み込み
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'proxy-config.json');
let config;
try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
    logger.error('設定ファイルの読み込みエラー:', err);
    process.exit(1);
}

// ホワイトリストの設定とキャッシュマネージャーの初期化
const whitelistManager = new WhitelistManager(logger);
whitelistManager.loadFromConfig(config);

// キャッシュディレクトリのパスを設定
const CACHE_DIR = path.join(__dirname, '..', 'cache');
const cacheManager = new CacheManager(CACHE_DIR, logger);

// 統計収集器の初期化
const statsCollector = new StatisticsCollector(logger);

// ホワイトリストドメインはWhitelistManager経由で取得
const whitelistedDomains = whitelistManager.domains;
const whitelistedRegexPatterns = whitelistManager.regexPatterns;

// キャッシュディレクトリの初期化
const initializeCacheDir = async () => {
    try {
        await cacheManager.initialize();
    } catch (err) {
        logger.error('初期化エラー:', err);
        throw err;
    }
};

// 起動時にキャッシュディレクトリを初期化
(async () => {
    await initializeCacheDir();
})().catch(err => {
    logger.error('初期化エラー:', err);
    process.exit(1);
});

// 証明書マネージャーの初期化
const certManager = new CertificateManager(config.https);

// HTTPSサーバーのオプション
const httpsOptions = {
    cert: null,
    key: null
};

// 証明書の初期化
(async () => {
    try {
        await certManager.initialize();
        httpsOptions.cert = certManager.getCertificate();
        httpsOptions.key = certManager.getPrivateKey();
        logger.log('証明書の初期化が完了しました');
    } catch (err) {
        logger.error('証明書の初期化に失敗しました:', err);
        process.exit(1);
    }
})();

// キャッシュのロード - エラー時にファイル削除を追加
const loadCache = async (cacheFile) => {
    return cacheManager.loadCache(cacheFile);
};

// キャッシュの保存
const saveCache = async (cacheFile, cacheHeader, body) => {
    return cacheManager.saveCache(cacheFile, cacheHeader, body);
};

// 定期的な統計情報のログ出力を開始
statsCollector.startPeriodicLogging(CACHE_DIR);

// 新しい接続が確立されたときにセットに追加
function trackConnection(socket) {
    return statsCollector.trackConnection(socket);
}

// ホワイトリストの確認用ヘルパー関数は単純にwhitelistManagerに委譲
const isHostWhitelisted = (host) => {
    return whitelistManager.isHostWhitelisted(host);
};

// プロキシリクエストの処理の修正 - レスポンス完了時に接続を終了
const handleProxyRequest = async (clientReq, clientRes, options, isWhitelisted, cacheFile, normalizedUrl, targetHost) => {
    // プロトコルに応じたモジュール選択
    const isHttps = options.port === 443;
    const proxyModule = isHttps ? https : http;
    
    logger.info(`${isHttps ? 'HTTPS' : 'HTTP'}リクエスト転送: ${options.hostname}:${options.port}${options.path}`);

    // 接続タイムアウトを設定
    const connectionTimeout = setTimeout(() => {
        logger.warn(`リクエストタイムアウト: ${normalizedUrl}`);
        if (!clientRes.headersSent) {
            clientRes.writeHead(504, { 'Content-Type': 'text/plain', 'Connection': 'close' });
        }
        if (!clientRes.finished) {
            clientRes.end('Request Timeout');
        }
        if (proxyReq && !proxyReq.destroyed) {
            proxyReq.destroy();
        }
    }, 30000); // 30秒タイムアウト

    const proxyReq = proxyModule.request(options, async (proxyRes) => {
        const chunks = [];
        const headers = { ...proxyRes.headers };

        // Connection: closeヘッダーを追加
        headers['Connection'] = 'close';

        if (isWhitelisted) {
            headers['X-Cache'] = 'MISS';
            logger.debug('ホワイトリスト対象でキャッシュミス:', normalizedUrl);
        }
        
        clientRes.writeHead(proxyRes.statusCode, headers);

        proxyRes.on('data', (chunk) => {
            chunks.push(chunk);
            clientRes.write(chunk);
        });

        proxyRes.on('end', async () => {
            // タイムアウトをクリア
            clearTimeout(connectionTimeout);
            
            // レスポンスを終了
            clientRes.end();
            
            logger.debug(`レスポンス完了: ${normalizedUrl}, ステータス:${proxyRes.statusCode}`);

            // キャッシュ処理
            if (isWhitelisted && proxyRes.statusCode === 200) {
                const responseData = Buffer.concat(chunks);
                
                logger.debug(`ホワイトリスト対象でキャッシュ予定: ${normalizedUrl}, データ長: ${responseData.length}バイト`);
                
                const cacheHeader = {
                    url: normalizedUrl,
                    statusCode: proxyRes.statusCode,
                    headers: proxyRes.headers,
                };

                try {
                    // キャッシュを保存
                    const cacheFile = getCacheFileName(normalizedUrl);
                    await saveCache(cacheFile, cacheHeader, responseData);
                    logger.debug('キャッシュ保存完了:', normalizedUrl);
                    
                    // キャッシュ保存カウンターを更新
                    if (isHttps) {
                        statsCollector.incrementHttpsStat('cacheSaves');
                    }

                    // ファイルの存在確認
                    try {
                        await fs.promises.access(cacheFile);
                        const stats = await fs.promises.stat(cacheFile);
                        logger.debug(`キャッシュファイル確認: ${cacheFile}, サイズ: ${stats.size}バイト`);
                    } catch (accessErr) {
                        logger.error('キャッシュファイル確認エラー:', accessErr);
                    }
                } catch (err) {
                    logger.error('キャッシュ保存エラー:', err);
                }
            } else {
                logger.debug(`キャッシュ非対象: ホワイトリスト=${isWhitelisted}, ステータス=${proxyRes.statusCode}`);
            }
            
            // 接続を明示的に終了
            if (clientReq.socket && !clientReq.socket.destroyed) {
                try {
                    clientReq.socket.end();
                } catch (err) {
                    logger.error('ソケット終了エラー:', err);
                }
            }
        });
        
        // エラーハンドラを追加
        proxyRes.on('error', (err) => {
            clearTimeout(connectionTimeout);
            logger.error(`プロキシレスポンスエラー: ${err.message}`);
            if (!clientRes.finished) {
                clientRes.end();
            }
            
            // 接続を終了
            if (clientReq.socket && !clientReq.socket.destroyed) {
                try {
                    clientReq.socket.end();
                } catch (err) {
                    logger.error('ソケット終了エラー:', err);
                }
            }
        });
    });

    proxyReq.on('error', (err) => {
        logger.error(`プロキシリクエストエラー(${isHttps ? 'HTTPS' : 'HTTP'}):`, err);
        if (!clientRes.headersSent) {
            clientRes.writeHead(500, {
                'Content-Type': 'text/plain',
                'Connection': 'close',
                'X-Proxy-Error': err.message
            });
        }
        if (!clientRes.finished) {
            clientRes.end(`プロキシ接続エラーが発生しました: ${err.message}`);
        }
    });

    // タイムアウトの設定を修正
    proxyReq.setTimeout(25000, () => {
        clearTimeout(connectionTimeout);
        logger.error('プロキシリクエストがタイムアウトしました');
        if (!clientRes.headersSent) {
            clientRes.writeHead(504, {
                'Content-Type': 'text/plain',
                'Connection': 'close'
            });
        }
        if (!clientRes.finished) {
            clientRes.end('リクエストがタイムアウトしました');
        }
        
        // 接続を終了
        if (clientReq.socket && !clientReq.socket.destroyed) {
            try {
                clientReq.socket.end();
            } catch (err) {
                logger.error('ソケット終了エラー:', err);
            }
        }
        
        proxyReq.destroy();
    });

    // リクエストボディの転送
    if (clientReq.method === 'POST' || clientReq.method === 'PUT') {
        clientReq.pipe(proxyReq);
    } else {
        proxyReq.end();
    }
};

// HTTPプロキシモード設定を一箇所にまとめ、重複宣言を削除
const DIRECT_TUNNEL_MODE = false;   // トンネルモードを無効化
const FORCE_DIRECT_HTTPS = true;    // 直接HTTPSを有効化
const DIRECT_HTTPS_CACHE = true;    // HTTPSキャッシュを有効化
const DEBUG_HTTP_PARSING = true;    // HTTPSリクエスト解析のデバッグフラグ
const SIMPLIFIED_MODE = true;       // シンプルモードを有効化（より確実なキャッシュ）
const USE_PREFETCH = true;          // ホワイトリストドメインのトップページを事前にキャッシュ
const USE_MITM = false;             // Man-in-the-middle機能を無効化（トラブル対応）

// SSL証明書検証の無効化設定を削除
// process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// HTTPSレスポンスをキャプチャしてキャッシュする - クエリパラメータを含める
function setupHttpsResponseCapture(targetSocket, clientSocket, normalizedUrl) {
    logger.debug(`HTTPSレスポンス保存設定開始: ${normalizedUrl}`);

    // レスポンスデータを収集するためのバッファ
    let responseBuffer = Buffer.alloc(0);
    let headersParsed = false;
    let headersEndPos = -1;
    let statusCode = 0;
    let responseHeaders = {};
    let responseStarted = false;

    // データ受信イベントのリスナーを追加
    const originalDataListeners = targetSocket.listeners('data').slice();
    targetSocket.removeAllListeners('data');

    targetSocket.on('data', function(chunk) {
        try {
            if (!responseStarted) {
                responseStarted = true;
                logger.debug(`HTTPSレスポンス受信開始: ${normalizedUrl}, サイズ=${chunk.length}`);
            }
            
            // レスポンスデータを蓄積
            responseBuffer = Buffer.concat([responseBuffer, chunk]);
            
            // ヘッダー部分がまだ解析されていない場合
            if (!headersParsed) {
                const headerEndIndex = responseBuffer.indexOf('\r\n\r\n');
                if (headerEndIndex !== -1) {
                    // ヘッダー部分を取り出して解析
                    const headerText = responseBuffer.slice(0, headerEndIndex).toString('utf8');
                    
                    // ステータスコードを取得
                    const statusMatch = headerText.match(/^HTTP\/\d\.\d\s+(\d+)/);
                    if (statusMatch) {
                        statusCode = parseInt(statusMatch[1], 10);
                    }
                    
                    // ヘッダーを解析
                    const headerLines = headerText.split('\r\n');
                    headerLines.slice(1).forEach(line => {
                        const colonPos = line.indexOf(':');
                        if (colonPos > 0) {
                            const name = line.substring(0, colonPos).trim().toLowerCase();
                            const value = line.substring(colonPos + 1).trim();
                            responseHeaders[name] = value;
                        }
                    });
                    
                    logger.debug(`HTTPSレスポンスヘッダー解析完了: status=${statusCode}, content-type=${responseHeaders['content-type'] || '不明'}`);
                    
                    headersParsed = true;
                    headersEndPos = headerEndIndex;
                }
            }
            
            // クライアントにデータを転送
            if (clientSocket && !clientSocket.destroyed) {
                clientSocket.write(chunk);
            }
        } catch (err) {
            logger.error('HTTPSレスポンス解析エラー:', err);
        }
    });

    // レスポンス完了時の処理を追加
    const endListeners = targetSocket.listeners('end').slice();
    targetSocket.removeAllListeners('end');
    
    targetSocket.on('end', async function() {
        if (headersEndPos > 0 && statusCode === 200) {
            try {
                // ボディ部分を抽出
                const bodyBuffer = responseBuffer.slice(headersEndPos + 4);
                logger.debug(`HTTPSレスポンス完了: ステータス=${statusCode}, データサイズ=${bodyBuffer.length}バイト`);
                
                // キャッシュデータを作成
                const cacheHeader = {
                    url: normalizedUrl,
                    statusCode: 200,
                    headers: responseHeaders,
                };
                
                // キャッシュを保存
                const cacheFile = getCacheFileName(normalizedUrl);
                
                try {
                    await saveCache(cacheFile, cacheHeader, bodyBuffer);
                    logger.debug(`HTTPSレスポンスをキャッシュしました: ${normalizedUrl}, サイズ=${bodyBuffer.length}バイト`);
                    statsCollector.incrementHttpsStat('cacheSaves');
                } catch (cacheErr) {
                    logger.error('HTTPSキャッシュ保存エラー:', cacheErr);
                }
            } catch (err) {
                logger.error('HTTPSレスポンス処理エラー:', err);
            }
        } else {
            logger.debug(`HTTPSレスポンスはキャッシュされません: ステータス=${statusCode}, ヘッダー解析=${headersParsed}`);
        }
        
        // 元のエンドリスナーを呼び出す
        for (const listener of endListeners) {
            try {
                listener.call(targetSocket);
            } catch (err) {
                logger.error('元のendリスナー呼び出しエラー:', err);
            }
        }
    });
}

// HTTPSリクエストのキャッシュ処理 - クエリパラメータ対応
const handleHttpsCache = async (clientSocket, targetSocket, requestInfo) => {
    const { host, path, method } = requestInfo;
    
    if (method !== 'GET') {
        logger.debug(`キャッシュ対象外メソッド: ${method}`);
        return false;
    }
    
    if (!isHostWhitelisted(host)) {
        logger.debug(`キャッシュ対象外ホスト: ${host}`);
        return false;
    }
    
    try {
        // キャッシュキーを生成 - pathにはクエリパラメータも含まれる
        const normalizedUrl = `https://${host}${path}`;
        logger.debug(`HTTPSキャッシュをチェック: ${normalizedUrl}`);
        
        // キャッシュファイル名を取得
        const cacheFile = getCacheFileName(normalizedUrl, { host });
        
        try {
            // キャッシュファイルの存在をチェック
            const cacheExists = await fileExists(cacheFile);
            
            if (cacheExists) {
                logger.debug(`HTTPSキャッシュが存在します: ${cacheFile}`);
                
                const cache = await loadCache(cacheFile);
                if (cache && cache.data) {
                    logger.info(`HTTPSキャッシュヒット: ${normalizedUrl}`);
                    statsCollector.incrementHttpsStat('cacheHits');
                    
                    try {
                        // キャッシュからレスポンスを構築
                        const responseData = Buffer.from(cache.data, 'base64');
                        const response = Buffer.concat([
                            Buffer.from(`HTTP/1.1 ${cache.statusCode} OK\r\n`),
                            Buffer.from(`Content-Type: ${cache.headers['content-type'] || 'text/html'}\r\n`),
                            Buffer.from(`Content-Length: ${responseData.length}\r\n`),
                            Buffer.from('X-Cache: HIT\r\n'),
                            Buffer.from('Connection: close\r\n\r\n'),
                            responseData
                        ]);
                        
                        // レスポンスをクライアントに送信
                        clientSocket.write(response);
                        
                        logger.debug(`キャッシュからのレスポンス送信完了: ${normalizedUrl}`);
                        
                        // レスポンス送信後に接続を終了 (少し遅延させる)
                        setTimeout(() => {
                            try {
                                if (!clientSocket.destroyed) {
                                    clientSocket.end();
                                }
                            } catch (endErr) {
                                logger.error('ソケット終了エラー:', endErr);
                            }
                        }, 100);
                        
                        return true;
                    } catch (writeErr) {
                        logger.error('キャッシュレスポンス送信エラー:', writeErr);
                    }
                } else {
                    logger.debug(`HTTPSキャッシュ内容が無効: ${normalizedUrl}`);
                    
                    // 無効なキャッシュファイルを削除
                    try {
                        logger.warn(`無効なキャッシュファイルを削除: ${cacheFile}`);
                        await fs.promises.unlink(cacheFile);
                    } catch (unlinkErr) {
                        logger.error('キャッシュファイル削除エラー:', unlinkErr);
                    }
                }
            } else {
                logger.debug(`HTTPSキャッシュミス: ${normalizedUrl}`);
                statsCollector.incrementHttpsStat('cacheMisses');
            }
        } catch (err) {
            logger.error('HTTPSキャッシュチェックエラー:', err);
            
            // エラーが発生した場合もキャッシュファイルの削除を試行
            try {
                await fs.promises.unlink(cacheFile);
                logger.warn(`エラーが発生したキャッシュファイルを削除: ${cacheFile}`);
            } catch (unlinkErr) {
                // 削除に失敗した場合は無視（ファイルが存在しない可能性もある）
            }
        }
        
        // キャッシュにヒットしなかった場合、レスポンスキャプチャを設定
        logger.debug(`HTTPSキャッシュミス - レスポンスキャプチャを設定: ${normalizedUrl}`);
        setupHttpsResponseCapture(targetSocket, clientSocket, normalizedUrl);
        
    } catch (err) {
        logger.error('HTTPSキャッシュ処理エラー:', err);
    }
    
    return false;
};

// 最もシンプルな実装のTLSトンネルを使用
function simpleProxyTunnel(clientSocket, targetSocket, head) {
    logger.log('シンプルな直接トンネルモードを使用しますが、HTTPSデータを解析してキャッシュします');
    
    // HTTPSリクエストのカウントを増やす
    statsCollector.incrementHttpsStat('connections');
    
    // 効率的なデータ転送のための設定
    clientSocket.setTimeout(0);
    targetSocket.setTimeout(0);
    clientSocket.setNoDelay(true);
    targetSocket.setNoDelay(true);
    
    let clientClosed = false;
    let targetClosed = false;
    let headSent = false;
    let isHttpsRequestProcessed = false;
    
    // HTTPリクエスト解析のための変数
    let requestBuffer = Buffer.alloc(0);
    let requestInfo = {
        host: null,
        path: null,
        method: null
    };
    
    // クリーンアップ関数
    function cleanup() {
        if (clientClosed && targetClosed) return; // 既にクリーンアップ済み
        
        try {
            if (!clientClosed && clientSocket && !clientSocket.destroyed) {
                clientClosed = true;
                clientSocket.end();
            }
        } catch (e) {
            logger.error('クライアントソケット終了エラー:', e.message || e);
        }
        
        try {
            if (!targetClosed && targetSocket && !targetSocket.destroyed) {
                targetClosed = true;
                targetSocket.end();
            }
        } catch (e) {
            logger.error('ターゲットソケット終了エラー:', e.message || e);
        }
    }
    
    // エラーハンドラ
    function handleError(side) {
        return (err) => {
            if (err.code === 'ECONNRESET') {
                logger.log(`${side}の接続がリセットされましたが、通常の終了として処理します`);
            } else {
                logger.error(`${side}エラー:`, err.message || err);
            }
            cleanup();
        };
    }
    
    // データ転送イベントリスナーの設定
    clientSocket.on('data', (chunk) => {
        try {
            // HTTPSリクエストの解析試行（初回のみ）
            if (!isHttpsRequestProcessed && chunk.length > 0) {
                // データをバッファに追加
                requestBuffer = Buffer.concat([requestBuffer, chunk]);
                
                // リクエストテキストに変換
                const requestText = requestBuffer.toString('utf8', 0, Math.min(requestBuffer.length, 4096));
                
                // ログを詳細化
                if (DEBUG_HTTP_PARSING) {
                    logger.log(`HTTPSリクエスト解析中: バイト数=${chunk.length}`);
                    
                    // テキストとしてパースできるか試みる
                    try {
                        const firstLine = requestText.split('\r\n')[0];
                        if (firstLine && firstLine.length > 0) {
                            logger.log(`HTTPSリクエスト最初の行: ${firstLine.substring(0, 80)}${firstLine.length > 80 ? '...' : ''}`);
                        }
                    } catch (e) {
                        logger.log('HTTPSリクエスト解析: テキスト解析失敗 (バイナリデータの可能性あり)');
                    }
                }
                
                // HTTP/1.1リクエスト形式かどうかチェック
                if (requestText.includes('\r\n\r\n') || requestText.includes('\r\n')) {
                    // リクエスト行を解析
                    const requestLines = requestText.split('\r\n');
                    const firstLine = requestLines[0];
                    
                    logger.log(`HTTPSリクエスト解析: ${firstLine}`);
                    
                    // HTTP GETリクエストの形式に合致するか確認
                    const match = firstLine.match(/^(GET|POST|PUT|DELETE|HEAD|OPTIONS) (.*) HTTP\/\d\.\d$/);
                    if (match) {
                        requestInfo.method = match[1];
                        requestInfo.path = match[2];
                        
                        // Hostヘッダーを探す
                        for (let i = 1; i < requestLines.length; i++) {
                            if (requestLines[i].toLowerCase().startsWith('host:')) {
                                requestInfo.host = requestLines[i].substring(5).trim();
                                break;
                            }
                        }
                        
                        // 解析結果をログ出力
                        if (requestInfo.host) {
                            logger.log('HTTPS解析データ:', {
                                method: requestInfo.method,
                                host: requestInfo.host,
                                path: requestInfo.path
                            });
                            
                            // ホワイトリストに含まれるかチェック
                            if (isHostWhitelisted(requestInfo.host)) {
                                logger.log('HTTPSホワイトリスト一致:', requestInfo.host);
                                
                                // リクエスト処理済みフラグを設定
                                isHttpsRequestProcessed = true;
                                
                                // キャッシュチェック処理を非同期で実行
                                handleHttpsCache(clientSocket, targetSocket, requestInfo)
                                    .then(cached => {
                                        if (cached) {
                                            logger.log('HTTPSキャッシュからデータ提供完了:', requestInfo.host + requestInfo.path);
                                        } else {
                                            logger.log('HTTPSキャッシュなし - 通常リクエストを実行:', requestInfo.host + requestInfo.path);
                                        }
                                    })
                                    .catch(err => {
                                        logger.error('HTTPSキャッシュエラー:', err);
                                    });
                            } else {
                                logger.log('HTTPSホワイトリスト対象外:', requestInfo.host);
                                isHttpsRequestProcessed = true;
                            }
                        } else {
                            logger.log('Hostヘッダーが見つかりません');
                        }
                    } else {
                        // HTTPリクエスト形式でない場合もリクエスト処理済みとマーク
                        isHttpsRequestProcessed = true;
                        logger.log('HTTP形式のリクエストではありません');
                    }
                }
            }
            
            // ターゲットソケットが書き込み可能であれば転送
            if (targetSocket && targetSocket.writable) {
                const flushed = targetSocket.write(chunk);
                
                // バックプレッシャー処理
                if (!flushed) {
                    clientSocket.pause();
                    targetSocket.once('drain', () => {
                        if (clientSocket.readable) {
                            clientSocket.resume();
                        }
                    });
                }
            } else {
                logger.log('ターゲットソケットに書き込めません：', targetSocket ? 'writable=false' : 'socket=null');
            }
        } catch (parseError) {
            logger.error('HTTPSリクエスト解析エラー:', parseError);
        }
    });
    
    targetSocket.on('data', (chunk) => {
        // クライアントソケットが書き込み可能か確認
        if (clientSocket.writable) {
            // データ書き込み
            const flushed = clientSocket.write(chunk);
            
            // バックプレッシャーの管理
            if (!flushed) {
                targetSocket.pause();
                clientSocket.once('drain', () => {
                    // ソケットがまだ有効であれば再開
                    if (targetSocket.readable) {
                        targetSocket.resume();
                    }
                });
            }
        }
    });
    
    // 接続終了イベントの処理
    clientSocket.on('end', () => {
        logger.info('クライアント接続が終了しました');
        clientClosed = true;
        if (!targetClosed && targetSocket.writable) {
            targetSocket.end();
        }
    });
    
    targetSocket.on('end', () => {
        logger.info('ターゲット接続が終了しました');
        targetClosed = true;
        if (!clientClosed && clientSocket.writable) {
            clientSocket.end();
        }
    });
    
    // エラーイベントの処理
    clientSocket.on('error', handleError('クライアント'));
    targetSocket.on('error', handleError('ターゲット'));
    
    // クローズイベントの処理
    clientSocket.on('close', () => {
        logger.info('クライアント接続がクローズされました');
        clientClosed = true;
        cleanup();
    });
    
    targetSocket.on('close', () => {
        logger.info('ターゲット接続がクローズされました');
        targetClosed = true;
        cleanup();
    });
    
    // ヘッダデータがあれば転送
    if (head && head.length > 0 && !headSent) {
        headSent = true;
        targetSocket.write(head);
    }
}

// HTTPSトンネルの設定
const setupHttpsTunnel = (clientSocket, targetSocket, head) => {
    // 直接トンネルモードの場合は、シンプルな実装を使用
    if (DIRECT_TUNNEL_MODE) {
        return simpleProxyTunnel(clientSocket, targetSocket, head);
    }
    
    // ... existing code for TLS interception mode ...
};

// 直接HTTPSリクエストを実行してキャッシュする関数
async function directHttpsRequest(url) {
    return new Promise((resolve, reject) => {
        logger.debug(`直接HTTPSリクエスト: ${url}`);
        
        // キャッシュキーを生成（クエリパラメータを含む）
        const cacheFile = getCacheFileName(url);
        
        // キャッシュが存在するか確認
        fs.access(cacheFile, async (err) => {
            if (!err) {
                // キャッシュが存在する場合
                try {
                    const cache = await loadCache(cacheFile);
                    if (cache && cache.data) {
                        logger.info(`キャッシュヒット: ${url}`);
                        statsCollector.incrementHttpsStat('cacheHits');
                        return resolve({
                            fromCache: true,
                            data: Buffer.from(cache.data, 'base64'),
                            headers: cache.headers,
                            statusCode: cache.statusCode
                        });
                    }
                    
                    // キャッシュデータがない場合はキャッシュファイルを削除
                    logger.warn(`不完全なキャッシュファイルを削除: ${cacheFile}`);
                    await fs.promises.unlink(cacheFile).catch(e => logger.error('キャッシュ削除エラー:', e));
                    
                } catch (cacheErr) {
                    logger.error('キャッシュ読み込みエラー:', cacheErr);
                    
                    // キャッシュエラーの場合はファイルを削除
                    try {
                        logger.warn(`エラーが発生したキャッシュファイルを削除: ${cacheFile}`);
                        await fs.promises.unlink(cacheFile);
                    } catch (unlinkErr) {
                        logger.error('キャッシュファイル削除エラー:', unlinkErr);
                    }
                }
            }
            
            // キャッシュがない場合またはエラーが発生した場合は直接リクエスト
            statsCollector.incrementHttpsStat('cacheMisses');
            logger.debug(`キャッシュミス - 直接リクエスト: ${url}`);
            
            // HTTPSリクエストのオプション設定
            const options = {
                headers: {
                    'User-Agent': 'Mozilla/5.0 ProxyAgent/1.0',
                    'Accept': '*/*',
                    'Accept-Encoding': 'identity'
                },
                timeout: 30000,
                method: 'GET',
                rejectUnauthorized: false  // 自己署名証明書も許可
            };
            
            try {
                const req = https.request(url, options, (res) => {
                    const chunks = [];
                    
                    res.on('data', (chunk) => {
                        chunks.push(chunk);
                    });
                    
                    res.on('end', async () => {
                        try {
                            const responseData = Buffer.concat(chunks);
                            logger.debug(`直接HTTPSリクエスト完了: ${url}, ステータス=${res.statusCode}, サイズ=${responseData.length}バイト`);
                            
                            // 成功レスポンスの場合だけキャッシュに保存
                            if (res.statusCode === 200) {
                                // キャッシュデータを作成
                                const cacheHeader = {
                                    url: url,
                                    statusCode: res.statusCode,
                                    headers: res.headers,
                                };
                                
                                // 非同期でキャッシュを保存
                                try {
                                    await saveCache(cacheFile, cacheHeader, responseData);
                                    statsCollector.incrementHttpsStat('cacheSaves');
                                    logger.debug(`HTTPSレスポンスをキャッシュしました: ${url}`);
                                } catch (err) {
                                    logger.error('キャッシュ保存エラー:', err);
                                }
                            }
                            
                            resolve({
                                fromCache: false,
                                data: responseData,
                                headers: res.headers,
                                statusCode: res.statusCode
                            });
                        } catch (processErr) {
                            logger.error('レスポンス処理エラー:', processErr);
                            reject(processErr);
                        }
                    });
                });
                
                req.on('error', (err) => {
                    logger.error('直接HTTPSリクエストエラー:', err);
                    reject(err);
                });
                
                req.on('timeout', () => {
                    logger.error('直接HTTPSリクエストタイムアウト:', url);
                    req.destroy();
                    reject(new Error("リクエストがタイムアウトしました"));
                });
                
                req.end();
            } catch (reqError) {
                logger.error('HTTPSリクエスト作成エラー:', reqError);
                reject(reqError);
            }
        });
    });
}

// シンプルなHTTPSプロキシリクエストハンドラ（プロキシとして受け取ったHTTPSリクエストをキャッシュ対象に）
async function handleSimplifiedHttpsRequest(req, res, targetHost) {
    // URLを構築（クエリパラメータを含む）
    const parsedUrl = new URL(req.url);
    const path = parsedUrl.pathname + parsedUrl.search; // クエリを含める
    const httpsUrl = `https://${targetHost}${path}`;
    
    logger.debug(`HTTPSリクエスト処理: ${httpsUrl}`);

    try {
        // 直接HTTPSリクエスト実行（キャッシュ確認含む）
        const response = await directHttpsRequest(httpsUrl);
        
        // ヘッダー設定（Connection: closeを追加）
        const headers = {
            ...response.headers,
            'X-Cache': response.fromCache ? 'HIT' : 'MISS',
            'X-Proxy': 'Node-Proxy/1.0',
            'Connection': 'close'
        };
        
        // レスポンス送信
        res.writeHead(response.statusCode, headers);
        res.end(response.data);
        
        logger.debug(`レスポンス送信完了: ${httpsUrl}`);
        
        // 接続を明示的に終了
        if (req.socket && !req.socket.destroyed) {
            try {
                req.socket.end();
            } catch (err) {
                logger.error('ソケット終了エラー:', err);
            }
        }
        
        return true;
    } catch (err) {
        logger.error(`HTTPSリクエストエラー: ${err.message}`);
        if (!res.headersSent) {
            res.writeHead(502, { 
                'Content-Type': 'text/plain',
                'Connection': 'close' 
            });
            res.end(`Proxy Error: ${err.message}`);
        }
        
        // エラー時も接続を終了
        if (req.socket && !req.socket.destroyed) {
            try {
                req.socket.end();
            } catch (err) {
                logger.error('ソケット終了エラー:', err);
            }
        }
        
        return false;
    }
}

// プロキシサーバーの作成 - クエリパラメータへの対応を改善
const server = http.createServer(async (clientReq, clientRes) => {
    logger.debug('リクエスト受信:', clientReq.method, clientReq.url);
    
    // HTTPリクエストをカウント
    statsCollector.incrementHttpStat('requests');

    const requestedHost = clientReq.headers.host;
    if (!requestedHost) {
        logger.debug('ホストヘッダーが欠落しています');
        clientRes.writeHead(400, { 'Content-Type': 'text/plain' });
        clientRes.end('Host header is required');
        return;
    }

    const targetHost = requestedHost.split(':')[0];

    try {
        if (requestedHost.includes('localhost:8000')) {
            logger.debug('直接アクセスを拒否:', requestedHost);
            clientRes.writeHead(400, { 'Content-Type': 'text/plain' });
            clientRes.end('直接のローカルホストへのリクエストは許可されていません');
            return;
        }

        // ホワイトリストチェック
        const isWhitelisted = isHostWhitelisted(targetHost);
        
        // URLを完全に正規化 - クエリパラメータを含める
        const isHttps = clientReq.url.startsWith('https://');
        let normalizedUrl;
        
        // 完全なURLでなければ構築する
        if (clientReq.url.startsWith('http://') || clientReq.url.startsWith('https://')) {
            normalizedUrl = clientReq.url;
        } else {
            normalizedUrl = `${isHttps ? 'https' : 'http'}://${requestedHost}${clientReq.url}`;
        }
        
        // URLを解析してクエリパラメータも保持
        const parsedUrl = new URL(normalizedUrl);
        normalizedUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}${parsedUrl.search}`;
        
        const cacheFile = getCacheFileName(normalizedUrl);
        
        logger.debug(`URL: ${normalizedUrl}, ホワイトリスト: ${isWhitelisted ? 'はい' : 'いいえ'}`);

        // 強制的に直接HTTPSリクエストを使用する場合
        if (FORCE_DIRECT_HTTPS && isHttps && isWhitelisted) {
            logger.debug('直接HTTPSリクエストモードを使用: ' + normalizedUrl);
            try {
                // 直接HTTPSリクエストを実行
                const response = await directHttpsRequest(normalizedUrl);
                
                // キャッシュからのレスポンスには独自のヘッダーを追加
                const headers = { 
                    ...response.headers,
                    'X-Cache': response.fromCache ? 'HIT' : 'MISS',
                    'X-Proxy': 'Node-Proxy/1.0',
                    'X-Cache-Source': response.fromCache ? 'cache' : 'direct'
                };
                
                clientRes.writeHead(response.statusCode, headers);
                clientRes.end(response.data);
                logger.debug(`${response.fromCache ? 'キャッシュ' : '直接リクエスト'}応答: ${normalizedUrl} (${response.data.length}バイト)`);
                
                // レスポンス送信後に接続を明示的に閉じる
                if (clientReq.socket && !clientReq.socket.destroyed) {
                    setTimeout(() => {
                        try {
                            clientReq.socket.end();
                        } catch (err) {
                            logger.error('ソケット終了エラー:', err);
                        }
                    }, 100);
                }
                
                return;
            } catch (err) {
                logger.error('直接HTTPSリクエスト処理エラー:', err);
                // エラーが発生した場合は通常のプロキシ処理にフォールバック
                logger.debug('通常のプロキシ処理にフォールバック');
            }
        }

        // キャッシュをチェック
        if (isWhitelisted) {
            try {
                await fs.promises.access(cacheFile);
                const cache = await loadCache(cacheFile);
                if (cache) {
                    logger.info('キャッシュヒット:', normalizedUrl);
                    statsCollector.incrementHttpStat('cacheHits'); // キャッシュヒットをカウント
                    if (isHttps) {
                        statsCollector.incrementHttpsStat('cacheHits');
                    }
                    
                    const headers = {
                        ...cache.headers,
                        'X-Cache': 'HIT',
                        'Content-Type': cache.headers['content-type'] || 'text/html',
                        'Connection': 'close'
                    };
                    clientRes.writeHead(cache.statusCode, headers);
                    clientRes.end(Buffer.from(cache.data, 'base64'));
                    
                    // レスポンス送信後に接続を明示的に閉じる
                    if (clientReq.socket && !clientReq.socket.destroyed) {
                        setTimeout(() => {
                            try {
                                clientReq.socket.end();
                            } catch (err) {
                                logger.error('ソケット終了エラー:', err);
                            }
                        }, 100);
                    }
                    
                    return;
                }
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    logger.error('キャッシュアクセスエラー:', err);
                    
                    // キャッシュファイルが存在するがアクセスに問題がある場合は削除を試行
                    try {
                        logger.warn(`問題のあるキャッシュファイルを削除: ${cacheFile}`);
                        await fs.promises.unlink(cacheFile);
                    } catch (unlinkErr) {
                        logger.error('キャッシュファイル削除エラー:', unlinkErr);
                    }
                }
                statsCollector.incrementHttpStat('cacheMisses'); // キャッシュミスをカウント
                if (isHttps) {
                    statsCollector.incrementHttpsStat('cacheMisses');
                }
            }
        }

        logger.info('プロキシ転送:', targetHost);
        
        // HTTPSリクエストかどうか判定
        const isHttpsRequest = clientReq.url.startsWith('https://');
        
        // リクエストオプション構築
        const options = {
            hostname: targetHost,
            port: isHttpsRequest ? 443 : 80,
            path: clientReq.url,
            method: clientReq.method,
            headers: {
                ...clientReq.headers,
                host: targetHost
            }
        };
        
        // URLがhttpから始まる場合は適切に処理
        if (clientReq.url.startsWith('http://') || clientReq.url.startsWith('https://')) {
            const parsedUrl = new URL(clientReq.url);
            options.hostname = parsedUrl.hostname;
            options.port = parsedUrl.port || (isHttpsRequest ? 443 : 80);
            options.path = parsedUrl.pathname + parsedUrl.search; // クエリパラメータを含める
        }

        logger.debug(`リクエスト: ${options.method} ${options.hostname}:${options.port}${options.path}`);

        await handleProxyRequest(clientReq, clientRes, options, isWhitelisted, cacheFile, normalizedUrl, targetHost);
    } catch (err) {
        logger.error('リクエスト処理エラー:', err);
        clientRes.writeHead(500, { 'Content-Type': 'text/plain' });
        clientRes.end('内部エラーが発生しました');
    }
});

// CONNECTリクエストのハンドリング（TLS終端とキャッシュを改善）
server.on('connect', (req, clientSocket, head) => {
    logger.info('CONNECT要求を受信:', req.url);
    
    // HTTPSリクエストをカウント
    statsCollector.incrementHttpsStat('requests');

    const [targetHost, targetPort] = req.url.split(':');
    const targetPortNum = parseInt(targetPort, 10) || 443;
    
    // ホワイトリストチェックログを追加
    const isTargetWhitelisted = isHostWhitelisted(targetHost);
    logger.info(`CONNECT ホワイトリストチェック: ${targetHost} - ${isTargetWhitelisted ? 'キャッシュ対象' : 'キャッシュ対象外'}`);
    
    // キャッシュ対象の場合、トップページを事前キャッシュ（非同期で実行）
    if (isTargetWhitelisted && USE_PREFETCH) {
        prefetchDomainContent(targetHost)
            .then(result => {
                if (result) {
                    logger.info(`[事前キャッシュ] ${targetHost} の取得に成功しました`);
                }
            })
            .catch(err => {
                logger.error(`[事前キャッシュ] ${targetHost} の取得に失敗しました:`, err);
            });
    }
    
    try {
        if (isTargetWhitelisted) {
            logger.info(`ホワイトリスト対象のためTLS終端処理: ${targetHost}`);
            handleHTTPSProxy(clientSocket, targetHost, targetPortNum, head);
        } else {
            logger.info(`ホワイトリスト対象外のため透過トンネル: ${targetHost}`);
            createTransparentTunnel(clientSocket, targetHost, targetPortNum, head);
        }
    } catch (err) {
        logger.error('CONNECT処理エラー:', err);
        if (!clientSocket.destroyed) {
            clientSocket.write('HTTP/1.1 500 Connection Error\r\n\r\n');
            clientSocket.end();
        }
    }
});

// キャッシュからのリクエスト処理
async function handleCachedRequest(host, path, clientSocket, targetSocket, originalChunk) {
    logger.info(`キャッシュ利用可能か確認: ${host}${path}`);
    
    // URLとキャッシュファイル名を生成
    const url = `https://${host}${path}`;
    
    const cacheFile = getCacheFileName(url);
    
    try {
        // キャッシュが存在するか確認
        const exists = await fileExists(cacheFile);
        if (exists) {
            const cache = await loadCache(cacheFile);
            if (cache && cache.data) {
                logger.info(`キャッシュヒット: ${url}`);
                statsCollector.incrementHttpsStat('cacheHits');
                
                // Base64デコード
                const data = Buffer.from(cache.data, 'base64');
                
                // HTTPレスポンス構築
                const response = [
                    `HTTP/1.1 ${cache.statusCode || 200} OK`,
                    `Content-Type: ${cache.headers['content-type'] || 'text/html'}`,
                    `Content-Length: ${data.length}`,
                    `X-Cache: HIT`,
                    `Date: ${new Date().toUTCString()}`,
                    `Connection: close`,
                    '',
                    ''
                ].join('\r\n');
                
                // レスポンス送信
                clientSocket.write(response);
                clientSocket.write(data);
                
                logger.info(`キャッシュからのレスポンス送信完了: ${url} (${data.length}バイト)`);
                return true;
            }
        }
        logger.info(`キャッシュミス: ${url}`);
        statsCollector.incrementHttpsStat('cacheMisses');
        return false;
    } catch (err) {
        logger.error('キャッシュチェックエラー:', err);
        return false;
    }
}

// レスポンスキャプチャ設定
function setupDataCapture(targetSocket, clientSocket, url) {
    logger.log(`レスポンスキャプチャ設定: ${url}`);

    // レスポンス収集用
    let responseChunks = [];
    let responseHeaders = null;
    let statusCode = 200;
    let isHeadersParsed = false;

    // 元のデータハンドラを保持
    const originalDataHandlers = targetSocket.listeners('data');
    targetSocket.removeAllListeners('data');
    
    // 新しいデータハンドラを設定
    targetSocket.on('data', (chunk) => {
        // データ蓄積
        responseChunks.push(chunk);
        
        // ヘッダー解析（初回チャンクのみ）
        if (!isHeadersParsed) {
            try {
                const headerText = chunk.toString('utf8', 0, Math.min(chunk.length, 1024));
                const match = headerText.match(/^HTTP\/\d\.\d (\d+)/i);
                if (match) {
                    statusCode = parseInt(match[1], 10);
                    
                    // ヘッダーの抽出
                    const headerEndPos = headerText.indexOf('\r\n\r\n');
                    if (headerEndPos > 0) {
                        const headers = {};
                        const headerLines = headerText.substring(0, headerEndPos).split('\r\n');
                        
                        headerLines.slice(1).forEach(line => {
                            const colonPos = line.indexOf(':');
                            if (colonPos > 0) {
                                const name = line.substring(0, colonPos).trim().toLowerCase();
                                const value = line.substring(colonPos + 1).trim();
                                headers[name] = value;
                            }
                        });
                        
                        responseHeaders = headers;
                        isHeadersParsed = true;
                        logger.log(`ヘッダー解析完了: ${url}, ステータス=${statusCode}`);
                    }
                }
            } catch (err) {
                logger.error('ヘッダー解析エラー:', err);
            }
        }
        
        // クライアントにデータを転送
        if (clientSocket.writable) {
            clientSocket.write(chunk);
        }
    });
    
    // 元のendイベントを保持して新しいものを設定
    const originalEndHandlers = targetSocket.listeners('end').slice();
    targetSocket.removeAllListeners('end');
    
    targetSocket.on('end', async () => {
        logger.info(`レスポンス受信完了: ${url}`);
        
        // キャッシュ保存の条件: 成功レスポンスでヘッダーが解析できている
        if (statusCode === 200 && responseHeaders && isHeadersParsed) {
            try {
                const responseData = Buffer.concat(responseChunks);
                
                // キャッシュデータを作成
                const cacheHeader = {
                    url: url,
                    statusCode: statusCode,
                    headers: responseHeaders,
                    data: responseData.toString('base64')
                };
                
                // キャッシュ保存
                const cacheFile = getCacheFileName(url);
                await saveCache(cacheFile, cacheHeader, responseData);
                statsCollector.incrementHttpsStat('cacheSaves');
                
                logger.info(`レスポンスをキャッシュしました: ${url}, サイズ=${responseData.length}バイト`);
            } catch (err) {
                logger.error('キャッシュ保存エラー:', err);
            }
        } else {
            logger.info(`キャッシュ非対象レスポンス: ${url}, ステータス=${statusCode}, ヘッダー解析=${isHeadersParsed}`);
        }
        
        // レスポンス処理完了後に接続を閉じる
        setTimeout(() => {
            try {
                // クライアントソケットを閉じる
                if (clientSocket && !clientSocket.destroyed) {
                    clientSocket.end();
                }
            } catch (endErr) {
                logger.error('クライアントソケット終了エラー:', endErr);
            }
        }, 100);
        
        // 元のendハンドラを実行
        for (const handler of originalEndHandlers) {
            handler.call(targetSocket);
        }
    });
}

// HTTPリクエスト用の直接レスポンス処理
function handleDirectHttpsRequest(req, res) {
    if (!req.url.startsWith('https://')) {
        return false;
    }
    
    logger.log(`直接HTTPSリクエスト処理: ${req.url}`);
    
    try {
        const url = new URL(req.url);
        const host = url.hostname;
        
        // ホワイトリストチェック
        const isWhitelisted = isHostWhitelisted(host);
        if (!isWhitelisted) {
            logger.info(`ホワイトリスト対象外: ${host} - 通常処理にフォールバック`);
            return false;
        }
        
        logger.info(`ホワイトリスト対象: ${host} - 直接処理`);
        
        // キャッシュファイル名
        const cacheFile = getCacheFileName(req.url);
        
        // キャッシュをチェック（非同期）
        fs.access(cacheFile, (err) => {
            if (!err) {
                // キャッシュが存在する場合
                loadCache(cacheFile)
                    .then(cache => {
                        if (cache && cache.data) {
                            logger.info(`キャッシュヒット: ${req.url}`);
                            statsCollector.incrementHttpStat('cacheHits');
                            
                            const headers = { ...cache.headers, 'X-Cache': 'HIT' };
                            const data = Buffer.from(cache.data, 'base64');
                            
                            res.writeHead(cache.statusCode, headers);
                            res.end(data);
                        } else {
                            sendDirectRequest(req, res, req.url, cacheFile);
                        }
                    })
                    .catch(err => {
                        logger.error('キャッシュ読み込みエラー:', err);
                        sendDirectRequest(req, res, req.url, cacheFile);
                    });
            } else {
                // キャッシュがない場合は直接リクエスト
                sendDirectRequest(req, res, req.url, cacheFile);
            }
        });
        
        return true;
    } catch (err) {
        logger.error('直接HTTPSリクエスト処理エラー:', err);
        return false;
    }
}

// 直接HTTPSリクエストの送信
function sendDirectRequest(clientReq, clientRes, url, cacheFile) {
    logger.info(`キャッシュミス - 直接リクエスト: ${url}`);
    statsCollector.incrementHttpStat('cacheMisses');
    
    const options = {
        headers: { ...clientReq.headers },
        method: clientReq.method
    };
    
    const proxyReq = https.request(url, options, (proxyRes) => {
        const chunks = [];
        const headers = { 
            ...proxyRes.headers, 
            'X-Cache': 'MISS',
            'Connection': 'close'  // 明示的に接続を閉じるヘッダーを追加
        };
        
        clientRes.writeHead(proxyRes.statusCode, headers);
        
        proxyRes.on('data', (chunk) => {
            chunks.push(chunk);
            clientRes.write(chunk);
        });
        
        proxyRes.on('end', async () => {
            clientRes.end();
            
            // レスポンス送信完了後に接続を閉じる
            if (clientReq.socket && !clientReq.socket.destroyed) {
                setTimeout(() => {
                    try {
                        clientReq.socket.end();
                    } catch (err) {
                        logger.error('ソケット終了エラー:', err);
                    }
                }, 100);
            }
            
            // 成功レスポンスのみキャッシュ
            if (proxyRes.statusCode === 200) {
                try {
                    const responseData = Buffer.concat(chunks);
                    
                    const cacheHeader = {
                        url: url,
                        statusCode: proxyRes.statusCode,
                        headers: proxyRes.headers,
                    };
                    
                    await saveCache(cacheFile, cacheHeader, responseData);
                    statsCollector.incrementHttpsStat('cacheSaves');
                    
                    logger.info(`HTTPSレスポンスをキャッシュしました: ${url}, サイズ=${responseData.length}バイト`);
                } catch (err) {
                    logger.error('キャッシュ保存エラー:', err);
                }
            }
        });
    });
    
    proxyReq.on('error', (err) => {
        logger.error('HTTPSプロキシエラー:', err);
        if (!clientRes.headersSent) {
            clientRes.writeHead(502, { 
                'Content-Type': 'text/plain',
                'Connection': 'close'
            });
            clientRes.end(`Proxy Error: ${err.message}`);
        }
        
        // エラー時も接続を閉じる
        if (clientReq.socket && !clientReq.socket.destroyed) {
            setTimeout(() => {
                try {
                    clientReq.socket.end();
                } catch (endErr) {
                    logger.error('ソケット終了エラー:', endErr);
                }
            }, 100);
        }
    });
    
    // リクエストボディ転送
    if (clientReq.method === 'POST' || clientReq.method === 'PUT') {
        clientReq.pipe(proxyReq);
    } else {
        proxyReq.end();
    }
}

// HTTPハンドラ
server.on('request', (req, res) => {
    logger.info(`受信したHTTPリクエスト: ${req.method} ${req.url}`);
    
    // HTTPSリクエストの直接処理を試行
    if (req.url.startsWith('https://')) {
        if (handleDirectHttpsRequest(req, res)) {
            return;
        }
    }
    
    // 既存の処理を継続
    // ...existing code...
});

// 引数からポートを取得するよう修正

// コマンドライン引数からポートを取得
function getPortFromArgs() {
  const args = process.argv.slice(2);
  for (const arg of args) {
    if (arg.startsWith('--port=')) {
      const port = parseInt(arg.split('=')[1], 10);
      if (!isNaN(port) && port > 0 && port < 65536) {
        return port;
      }
    }
  }
  // 環境変数からも取得を試みる
  if (process.env.PORT) {
    const port = parseInt(process.env.PORT, 10);
    if (!isNaN(port) && port > 0 && port < 65536) {
      return port;
    }
  }
  // デフォルト値
  return 8000;
}

// サーバー起動時のポート設定
const PORT = getPortFromArgs();

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        logger.error(`ポート ${PORT} は既に使用中です`);
    } else {
        logger.error('サーバーエラー:', err);
    }
    process.exit(1);
});

// 強化されたクリーンアップ関数
const cleanup = () => {
    logger.log('シャットダウンを開始します...');
    
    // シャットダウン開始時間を記録
    const shutdownStart = Date.now();
    
    // 新しい接続を受け付けない
    server.close(() => {
        logger.log('サーバーがすべての新規接続を拒否しています');
    });
    
    // アクティブな接続数をログに記録
    logger.log(`アクティブな接続数: ${statsCollector.activeConnections.size}`);
    
    // すべてのアクティブな接続を終了
    if (statsCollector.activeConnections.size > 0) {
        logger.log('すべてのアクティブな接続を終了しています...');
        statsCollector.activeConnections.forEach(socket => {
            try {
                // コネクション終了シグナルを送信
                if (!socket.destroyed) {
                    socket.end();
                    // 少し待っても終了しない場合は強制終了
                    setTimeout(() => {
                        if (!socket.destroyed) {
                            logger.log('ソケットを強制終了します');
                            socket.destroy();
                        }
                    }, 1000);
                }
            } catch (e) {
                logger.error('ソケット終了エラー:', e.message);
                // エラーが発生しても強制終了を試みる
                try {
                    socket.destroy();
                } catch (ignored) {
                    // 無視
                }
            }
        });
    }

    // すべての接続が終了するまで待つか、タイムアウトしたら強制終了
    const forcedExitTimeout = setTimeout(() => {
        logger.log(`強制終了: ${Date.now() - shutdownStart}ms経過後もプロセスが終了しませんでした`);
        process.exit(1); // 強制終了コード
    }, 5000); // 5秒のタイムアウト

    // 定期的にアクティブ接続をチェック
    const intervalCheck = setInterval(() => {
        if (statsCollector.activeConnections.size === 0) {
            clearInterval(intervalCheck);
            clearTimeout(forcedExitTimeout);
            logger.log(`正常終了: すべての接続が閉じられました (${Date.now() - shutdownStart}ms)`);
            process.exit(0);
        } else {
            logger.log(`まだ ${statsCollector.activeConnections.size} 個の接続が残っています...`);
            // 残存接続を強制終了
            statsCollector.activeConnections.forEach(socket => {
                try {
                    if (!socket.destroyed) {
                        socket.destroy();
                    }
                } catch (ignored) {
                    // 無視
                }
            });
        }
    }, 1000); // 1秒ごとにチェック
};

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

server.listen(PORT, () => {
    logger.log(`プロキシサーバーが起動しました - ポート ${PORT}`);
});

// APIエンドポイントハンドラーを初期化
const apiEndpoints = new ApiEndpoints({
    logger,
    statsCollector,
    whitelistManager,
    cacheManager,
    cacheDir: CACHE_DIR,
    directHttpsRequest
});

// 既存のサーバーリクエストハンドラを置き換え
server.on('request', (req, res) => {
    // APIエンドポイントの処理を試みる
    if (apiEndpoints.handleRequest(req, res)) {
        // APIエンドポイントとして処理された場合は終了
        return;
    }

    // ここから下は通常のプロキシリクエスト処理
    logger.info(`受信したHTTPリクエスト: ${req.method} ${req.url}`);
    
    // HTTPSリクエストの直接処理を試行
    if (req.url.startsWith('https://')) {
        if (handleDirectHttpsRequest(req, res)) {
            return;
        }
    }
    
    // 既存の処理を継続（通常のプロキシ処理）
    // ...existing code...
});

// パッシブTLS分析をやめて単純に事前キャッシュを行う
async function prefetchDomainContent(domain) {
    if (!whitelistedDomains.has(domain)) {
        return null; // ホワイトリスト対象外はスキップ
    }

    const url = `https://${domain}/`;
    logger.info(`[事前キャッシュ] ${domain}のトップページを取得します: ${url}`);
    
    try {
        const response = await directHttpsRequest(url);
        logger.info(`[事前キャッシュ] ${domain}のトップページ取得完了: ${response.fromCache ? 'キャッシュから取得' : '新規取得'} (${response.data.length}バイト)`);
        return response;
    } catch (err) {
        logger.error(`[事前キャッシュ] ${domain}のトップページ取得に失敗: ${err.message}`);
        return null;
    }
}

// 適切にTLS対応した中継サーバーを生成
function createTlsRelayServer(clientSocket, targetHost, targetPort) {
    logger.info(`TLS中継サーバーを作成: ${targetHost}:${targetPort}`);
    
    try {
        // TLSサーバーオプションを設定
        const tlsOptions = {
            key: certManager.getPrivateKey(),
            cert: certManager.getCertificate(),
            requestCert: false,
            rejectUnauthorized: false
        };
        
        // TLSサーバーを作成
        const tlsServer = tls.createServer(tlsOptions, (tlsSocket) => {
            logger.info(`TLS接続確立: ${targetHost}`);
            
            // リクエスト情報
            let currentRequest = null;
            
            // HTTP解析
            tlsSocket.on('data', async (data) => {
                try {
                    const requestText = data.toString('utf8');
                    
                    // HTTP/HTTPS リクエストを解析
                    if (requestText.match(/^(GET|POST|PUT|DELETE|HEAD|OPTIONS) .* HTTP\/\d\.\d/)) {
                        // リクエスト行とヘッダーを分離
                        const headersEndPos = requestText.indexOf('\r\n\r\n');
                        if (headersEndPos !== -1) {
                            const headerText = requestText.substring(0, headersEndPos);
                            const headerLines = headerText.split('\r\n');
                            const [method, path] = headerLines[0].split(' ');
                            
                            // ホストヘッダーを取得
                            let host = targetHost;
                            for (let i = 1; i < headerLines.length; i++) {
                                if (headerLines[i].toLowerCase().startsWith('host:')) {
                                    host = headerLines[i].substring(5).trim();
                                    break;
                                }
                            }
                            
                            currentRequest = { method, path, host };
                            logger.info(`TLS経由リクエスト: ${method} ${host}${path}`);
                            
                            // GETリクエスト + ホワイトリスト対象の場合、キャッシュを確認
                            if (method === 'GET' && isHostWhitelisted(host)) {
                                const fullUrl = `https://${host}${path}`;
                                
                                const cacheFile = getCacheFileName(fullUrl);
                                
                                try {
                                    // キャッシュを確認
                                    if (await fileExists(cacheFile)) {
                                        const cache = await loadCache(cacheFile);
                                        if (cache && cache.data) {
                                            logger.info(`キャッシュヒット: ${fullUrl}`);
                                            statsCollector.incrementHttpsStat('cacheHits');
                                            
                                            // キャッシュからのレスポンスを構築
                                            const responseData = Buffer.from(cache.data, 'base64');
                                            const responseHeaders = [];
                                            
                                            // レスポンスヘッダーを構築
                                            responseHeaders.push(`HTTP/1.1 ${cache.statusCode || 200} OK`);
                                            
                                            if (cache.headers) {
                                                Object.entries(cache.headers).forEach(([key, value]) => {
                                                    // 特定のヘッダーは除外（転送エンコーディングなど）
                                                    if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
                                                        responseHeaders.push(`${key}: ${value}`);
                                                    }
                                                });
                                            }
                                            
                                            responseHeaders.push('X-Cache: HIT');
                                            responseHeaders.push(`Content-Length: ${responseData.length}`);
                                            responseHeaders.push('Connection: close');
                                            responseHeaders.push('');
                                            responseHeaders.push('');
                                            
                                            // キャッシュからのレスポンスを送信
                                            tlsSocket.write(responseHeaders.join('\r\n'));
                                            tlsSocket.write(responseData);
                                            
                                            logger.info(`キャッシュからのレスポンス送信完了: ${fullUrl}`);
                                            
                                            // ソケットを閉じる
                                            setTimeout(() => {
                                                try {
                                                    if (!tlsSocket.destroyed) {
                                                        tlsSocket.end();
                                                    }
                                                } catch (endErr) {
                                                    logger.error('TLSソケット終了エラー:', endErr);
                                                }
                                            }, 100);
                                            
                                            return;
                                        }
                                    }
                                } catch (err) {
                                    logger.error('キャッシュ確認エラー:', err);
                                }
                            }
                            
                            // キャッシュミスか対象外の場合、実際のリクエストを実行
                            const targetOptions = {
                                hostname: host,
                                port: targetPort,
                                path: path,
                                method: method,
                                headers: {},
                                rejectUnauthorized: false
                            };
                            
                            // ヘッダーをコピー
                            for (let i = 1; i < headerLines.length; i++) {
                                const colonPos = headerLines[i].indexOf(':');
                                if (colonPos > 0) {
                                    const name = headerLines[i].substring(0, colonPos).trim();
                                    const value = headerLines[i].substring(colonPos + 1).trim();
                                    targetOptions.headers[name] = value;
                                }
                            }
                            
                            // リクエストの実行
                            const request = https.request(targetOptions, (response) => {
                                logger.info(`リモートサーバーからのレスポンス: ${host}${path}, ステータス=${response.statusCode}`);
                                
                                // ヘッダー送信
                                let responseText = `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`;
                                Object.entries(response.headers).forEach(([key, value]) => {
                                    if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
                                        responseText += `${key}: ${value}\r\n`;
                                    }
                                });
                                responseText += 'X-Cache: MISS\r\n';
                                responseText += 'Connection: close\r\n\r\n';
                                
                                tlsSocket.write(responseText);
                                
                                // キャッシュ用のデータ収集
                                const chunks = [];
                                
                                response.on('data', (chunk) => {
                                    chunks.push(chunk);
                                    tlsSocket.write(chunk);
                                });
                                
                                response.on('end', async () => {
                                    // 成功レスポンスのみキャッシュ
                                    if (method === 'GET' && isHostWhitelisted(host) && response.statusCode === 200) {
                                        try {
                                            const responseData = Buffer.concat(chunks);
                                            
                                            // キャッシュデータを作成
                                            const cacheHeader = {
                                                url: fullUrl,
                                                statusCode: response.statusCode,
                                                headers: response.headers,
                                            };
                                            
                                            // キャッシュを保存
                                            const cacheFile = getCacheFileName(fullUrl);
                                            await saveCache(cacheFile, cacheHeader, responseData);
                                            statsCollector.incrementHttpsStat('cacheSaves');
                                            
                                            logger.info(`HTTPSレスポンスをキャッシュしました: ${fullUrl}, サイズ=${responseData.length}バイト`);
                                        } catch (err) {
                                            logger.error('キャッシュ保存エラー:', err);
                                        }
                                    }
                                    
                                    // レスポンス完了後にソケットを閉じる
                                    setTimeout(() => {
                                        try {
                                            if (!tlsSocket.destroyed) {
                                                tlsSocket.end();
                                            }
                                        } catch (endErr) {
                                            logger.error('TLSソケット終了エラー:', endErr);
                                        }
                                    }, 100);
                                });
                            });
                            
                            request.on('error', (err) => {
                                logger.error(`リモートサーバーリクエストエラー: ${err}`);
                                
                                const errorResponse = [
                                    'HTTP/1.1 502 Bad Gateway',
                                    'Content-Type: text/plain',
                                    `Content-Length: ${err.message.length + 16}`,
                                    'Connection: close',
                                    '',
                                    `エラー発生: ${err.message}`
                                ].join('\r\n');
                                
                                tlsSocket.write(errorResponse);
                                tlsSocket.end();
                            });
                            
                            // リクエストボディがある場合は転送
                            if (headersEndPos + 4 < requestText.length) {
                                const body = requestText.substring(headersEndPos + 4);
                                request.write(body);
                            }
                            
                            request.end();
                        }
                    }
                } catch (err) {
                    logger.error('リクエスト処理エラー:', err);
                }
            });
            
            // エラーハンドリング
            tlsSocket.on('error', (err) => {
                logger.error('TLSソケットエラー:', err.message);
            });
            
            tlsSocket.on('end', () => {
                logger.info('TLSコネクション終了');
            });
        });
        
        // TLSサーバーエラーハンドリング
        tlsServer.on('error', (err) => {
            logger.error(`TLSサーバーエラー: ${err.message}`);
            clientSocket.end();
        });
        
        // TLSサーバーを一時的なポートにバインド
        tlsServer.listen(0, 'localhost', () => {
            const tlsServerPort = tlsServer.address().port;
            logger.info(`TLSサーバーをポート ${tlsServerPort} で起動しました`);
            
            // 確立された接続をそのTLSサーバーに接続
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n' +
                          'Connection: keep-alive\r\n' +
                          'Proxy-Agent: Node-Proxy/1.0\r\n\r\n', () => {
                logger.info('クライアントに接続成功を通知しました');
                
                // TLSサーバーへの接続
                const localSocket = net.connect({
                    host: 'localhost',
                    port: tlsServerPort
                }, () => {
                    logger.info(`ローカルTLSサーバーに接続しました: localhost:${tlsServerPort}`);
                    
                    // 双方向のデータ転送をセットアップ
                    clientSocket.pipe(localSocket);
                    localSocket.pipe(clientSocket);
                    
                    // クリーンアップ処理
                    localSocket.on('end', () => {
                        clientSocket.end();
                    });
                    
                    clientSocket.on('end', () => {
                        localSocket.end();
                    });
                    
                    localSocket.on('error', (err) => {
                        logger.error('ローカルソケットエラー:', err);
                        clientSocket.end();
                    });
                    
                    clientSocket.on('error', (err) => {
                        logger.error('クライアントソケットエラー:', err);
                        localSocket.end();
                    });
                    
                    localSocket.on('close', () => {
                        if (!clientSocket.destroyed) {
                            clientSocket.end();
                        }
                    });
                    
                    clientSocket.on('close', () => {
                        if (!localSocket.destroyed) {
                            localSocket.end();
                        }
                    });
                });
                
                localSocket.on('error', (err) => {
                    logger.error(`ローカルTLSサーバー接続エラー: ${err.message}`);
                    clientSocket.end();
                });
            });
        });
    } catch (err) {
        logger.error(`TLS中継サーバー作成エラー: ${err.message}`);
        clientSocket.destroy();
    }
}

// HTTPS用の単純化した透過プロキシ - よりシンプルな実装
function createSimpleTunnel(clientSocket, targetHost, targetPort, head) {
    logger.info(`単純トンネル作成: ${targetHost}:${targetPort}`);
    
    const targetSocket = net.connect(targetPort, targetHost, () => {
        logger.info(`ターゲット接続確立: ${targetHost}:${targetPort}`);
        
        // クライアントに接続成功を通知
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n' +
                        'Connection: keep-alive\r\n' +
                        'Proxy-Agent: Node-Proxy/1.0\r\n\r\n');
        
        // HTTPSリクエストのカウントを増やす
        statsCollector.incrementHttpsStat('connections');
        
        // 効率的なデータ転送のための設定
        clientSocket.setTimeout(0);
        targetSocket.setTimeout(0);
        clientSocket.setNoDelay(true);
        targetSocket.setNoDelay(true);
        
        let clientClosed = false;
        let targetClosed = false;
        let headSent = false;
        let isHttpsRequestProcessed = false;
        
        // HTTPリクエスト解析のための変数
        let requestBuffer = Buffer.alloc(0);
        let requestInfo = {
            host: null,
            path: null,
            method: null
        };
        
        // クリーンアップ関数
        function cleanup() {
            if (clientClosed && targetClosed) return; // 既にクリーンアップ済み
            
            try {
                if (!clientClosed && clientSocket && !clientSocket.destroyed) {
                    clientClosed = true;
                    clientSocket.end();
                }
            } catch (e) {
                logger.error('クライアントソケット終了エラー:', e.message || e);
            }
            
            try {
                if (!targetClosed && targetSocket && !targetSocket.destroyed) {
                    targetClosed = true;
                    targetSocket.end();
                }
            } catch (e) {
                logger.error('ターゲットソケット終了エラー:', e.message || e);
            }
        }
        
        // データ転送イベントリスナーの設定
        clientSocket.on('data', (chunk) => {
            try {
                // HTTPSリクエストの解析試行
                requestBuffer = Buffer.concat([requestBuffer, chunk]);
                
                // リクエストテキストに変換して解析
                const requestText = requestBuffer.toString('utf8', 0, Math.min(requestBuffer.length, 4096));
                
                // 現在のリクエストが完了したら、次のリクエストの解析のためにバッファをリセット
                if (requestText.includes('\r\n\r\n')) {
                    // リクエスト行を解析
                    const requestLines = requestText.split('\r\n');
                    const firstLine = requestLines[0];
                    
                    logger.log(`HTTPSリクエスト解析: ${firstLine}`);
                    
                    // HTTP GETリクエストの形式に合致するか確認
                    const match = firstLine.match(/^(GET|POST|PUT|DELETE|HEAD|OPTIONS) (.*) HTTP\/\d\.\d$/);
                    if (match) {
                        requestInfo = {
                            method: match[1],
                            path: match[2],
                            host: targetHost // デフォルトとしてCONNECTで指定されたホスト名を使用
                        };
                        
                        // Hostヘッダーを探して上書き
                        for (let i = 1; i < requestLines.length; i++) {
                            if (requestLines[i].toLowerCase().startsWith('host:')) {
                                requestInfo.host = requestLines[i].substring(5).trim();
                                break;
                            }
                        }
                        
                        // パスの正規化
                        if (requestInfo.path !== '/') {
                            logger.log(`HTTPS: ${requestInfo.method} ${requestInfo.host}${requestInfo.path}`);
                            
                            // ホワイトリストに含まれるかチェック
                            if (isHostWhitelisted(requestInfo.host)) {
                                logger.log('HTTPSホワイトリスト一致:', requestInfo.host + requestInfo.path);
                                
                                // キャッシュチェック処理
                                (async () => {
                                    const cacheUrl = `https://${requestInfo.host}${requestInfo.path}`;
                                                                        
                                    const cacheFile = getCacheFileName(cacheUrl);
                                    
                                    try {
                                        // キャッシュファイルの存在確認
                                        if (await fileExists(cacheFile)) {
                                            const cache = await loadCache(cacheFile);
                                            if (cache && cache.data) {
                                                logger.log(`HTTPSキャッシュヒット: ${cacheUrl}`);
                                                statsCollector.incrementHttpsStat('cacheHits');
                                                // ここではキャッシュを提供しない
                                                // (すでにターゲットにリクエストが送信されている)
                                            }
                                        } else {
                                            logger.log(`HTTPSキャッシュミス: ${cacheUrl}`);
                                            statsCollector.incrementHttpsStat('cacheMisses');
                                            
                                            // レスポンスをキャプチャするリスナーを設置
                                            setupResponseCapture(targetSocket, clientSocket, cacheUrl);
                                        }
                                    } catch (err) {
                                        logger.error('HTTPSキャッシュチェックエラー:', err);
                                    }
                                })();
                            }
                        }
                        
                        // リクエスト完了後、バッファリセット
                        requestBuffer = Buffer.alloc(0);
                    }
                }
                
                // ターゲットソケットが書き込み可能であれば転送
                if (targetSocket && targetSocket.writable) {
                    const flushed = targetSocket.write(chunk);
                    
                    // バックプレッシャー処理
                    if (!flushed) {
                        clientSocket.pause();
                        targetSocket.once('drain', () => {
                            if (clientSocket.readable) {
                                clientSocket.resume();
                            }
                        });
                    }
                }
            } catch (parseError) {
                logger.error('HTTPSリクエスト解析エラー:', parseError);
                
                // エラー時もデータは転送する
                if (targetSocket && targetSocket.writable) {
                    targetSocket.write(chunk);
                }
            }
        });
        
        // ヘッドデータがあれば転送
        if (head && head.length > 0 && !headSent) {
            headSent = true;
            targetSocket.write(head);
        }
        
        // レスポンスキャプチャ用の関数
        function setupResponseCapture(socket, clientSocket, url) {
            logger.log(`レスポンスキャプチャ設定: ${url}`);
            
            // レスポンス収集用の変数
            let responseBuffer = Buffer.alloc(0);
            let headersParsed = false;
            let headersEndPos = -1;
            let statusCode = 0;
            let responseHeaders = {};
            
            // オリジナルのデータリスナー
            const originalDataHandler = function(chunk) {
                // データを転送
                if (clientSocket && !clientSocket.destroyed) {
                    clientSocket.write(chunk);
                }
            };
            
            // データイベントハンドラ
            const captureDataHandler = function(chunk) {
                try {
                    // レスポンスデータを蓄積
                    responseBuffer = Buffer.concat([responseBuffer, chunk]);
                    
                    // ヘッダー部分が解析されていない場合
                    if (!headersParsed) {
                        const headerEndIndex = responseBuffer.indexOf('\r\n\r\n');
                        if (headerEndIndex !== -1) {
                            // ヘッダー部分を解析
                            const headerText = responseBuffer.slice(0, headerEndIndex).toString('utf8');
                            
                            // ステータスコードを取得
                            const statusMatch = headerText.match(/^HTTP\/\d\.\d\s+(\d+)/);
                            if (statusMatch) {
                                statusCode = parseInt(statusMatch[1], 10);
                            }
                            
                            // ヘッダーを解析
                            const headerLines = headerText.split('\r\n');
                            headerLines.slice(1).forEach(line => {
                                const colonPos = line.indexOf(':');
                                if (colonPos > 0) {
                                    const name = line.substring(0, colonPos).trim().toLowerCase();
                                    const value = line.substring(colonPos + 1).trim();
                                    responseHeaders[name] = value;
                                }
                            });
                            
                            headersParsed = true;
                            headersEndPos = headerEndIndex;
                            logger.log(`レスポンスヘッダー解析完了: status=${statusCode}, content-type=${responseHeaders['content-type'] || '不明'}`);
                        }
                    }
                    
                    // クライアントにデータを転送
                    originalDataHandler(chunk);
                } catch (err) {
                    logger.error('レスポンス解析エラー:', err);
                    originalDataHandler(chunk);
                }
            };
            
            // endイベントハンドラ
            const captureEndHandler = async function() {
                // ヘッダーとステータスコードが正常に解析され、成功レスポンスの場合
                if (headersParsed && headersEndPos > 0 && (statusCode === 200)) {
                    try {
                        // レスポンスの本体部分を抽出
                        const bodyData = responseBuffer.slice(headersEndPos + 4);
                        
                        logger.log(`レスポンス受信完了: ${url}, ステータス=${statusCode}, サイズ=${bodyData.length}バイト`);
                        
                        // キャッシュデータを作成
                        const cacheHeader = {
                            url: url,
                            statusCode: statusCode,
                            headers: responseHeaders,
                        };
                        
                        // キャッシュファイル名を取得
                        const cacheFile = getCacheFileName(url);
                        
                        // キャッシュを保存
                        await saveCache(cacheFile, cacheHeader, bodyData);
                        statsCollector.incrementHttpsStat('cacheSaves');
                        logger.log(`HTTPSレスポンスをキャッシュしました: ${url}, サイズ=${bodyData.length}バイト`);
                    } catch (err) {
                        logger.error('キャッシュ保存エラー:', err);
                    }
                }
                
                // 元のリスナーを削除
                socket.removeListener('data', captureDataHandler);
                
                // データハンドラとendハンドラを元に戻す
                socket.on('data', originalDataHandler);
            };
            
            // 現在のデータハンドラを保存
            const currentDataHandlers = socket.listeners('data').slice();
            socket.removeAllListeners('data');
            
            // 新しいキャプチャハンドラを設定
            socket.on('data', captureDataHandler);
            
            // レスポンス終了時の処理
            socket.once('end', captureEndHandler);
        }
        
        // レスポンス処理
        targetSocket.on('data', (chunk) => {
            // クライアントソケットが書き込み可能か確認
            if (clientSocket && clientSocket.writable) {
                // データ書き込み
                const flushed = clientSocket.write(chunk);
                
                // バックプレッシャーの管理
                if (!flushed) {
                    targetSocket.pause();
                    clientSocket.once('drain', () => {
                        // ソケットがまだ有効であれば再開
                        if (targetSocket.readable) {
                            targetSocket.resume();
                        }
                    });
                }
            }
        });
        
        // 接続終了イベントの処理
        clientSocket.on('end', () => {
            logger.info('クライアント接続が終了しました');
            clientClosed = true;
            if (!targetClosed && targetSocket && targetSocket.writable) {
                targetSocket.end();
            }
        });
        
        targetSocket.on('end', () => {
            logger.info('ターゲット接続が終了しました');
            targetClosed = true;
            if (!clientClosed && clientSocket && clientSocket.writable) {
                clientSocket.end();
            }
        });
        
        // エラーイベントの処理
        clientSocket.on('error', (err) => {
            logger.error(`クライアントソケットエラー: ${err.message}`);
            if (!targetClosed && targetSocket && !targetSocket.destroyed) {
                targetSocket.end();
            }
            cleanup();
        });
        
        targetSocket.on('error', (err) => {
            logger.error(`ターゲットソケットエラー: ${err.message}`);
            if (!clientClosed && clientSocket && !clientSocket.destroyed) {
                clientSocket.end();
            }
            cleanup();
        });
        
        // クローズイベントの処理
        clientSocket.on('close', () => {
            logger.info('クライアント接続がクローズされました');
            clientClosed = true;
            cleanup();
        });
        
        targetSocket.on('close', () => {
            logger.info('ターゲット接続がクローズされました');
            targetClosed = true;
            cleanup();
        });
    });
    
    targetSocket.on('error', (err) => {
        logger.error(`ターゲット接続エラー: ${err.message}`);
        if (!clientSocket.destroyed) {
            clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            clientSocket.end();
        }
    });
}

// 直接HTTPSリクエストを実行してキャッシュする関数（完全パスでキャッシュするよう修正）
async function directHttpsRequest(url) {
    return new Promise((resolve, reject) => {
        logger.debug(`直接HTTPSリクエスト: ${url}`);
        

        // キャッシュキーを生成（クエリパラメータを含む）
        const cacheFile = getCacheFileName(url);
        
        // キャッシュが存在するか確認
        fs.access(cacheFile, async (err) => {
            if (!err) {
                // キャッシュが存在する場合
                try {
                    const cache = await loadCache(cacheFile);
                    if (cache && cache.data) {
                        logger.info(`キャッシュヒット: ${url}`);
                        statsCollector.incrementHttpsStat('cacheHits');
                        return resolve({
                            fromCache: true,
                            data: Buffer.from(cache.data, 'base64'),
                            headers: cache.headers,
                            statusCode: cache.statusCode
                        });
                    }
                } catch (cacheErr) {
                    logger.error('キャッシュ読み込みエラー:', cacheErr);
                    // キャッシュエラーの場合は直接リクエストにフォールバック
                }
            }
            
            // キャッシュがない場合またはエラーが発生した場合は直接リクエスト
            statsCollector.incrementHttpsStat('cacheMisses');
            logger.debug(`キャッシュミス - 直接リクエスト: ${url}`);
            
            // HTTPSリクエストのオプション設定
            const options = {
                headers: {
                    'User-Agent': 'Mozilla/5.0 ProxyAgent/1.0',
                    'Accept': '*/*',
                    'Accept-Encoding': 'identity'
                },
                timeout: 30000,
                method: 'GET',
                rejectUnauthorized: false  // 自己署名証明書も許可
            };
            
            try {
                const req = https.request(url, options, (res) => {
                    const chunks = [];
                    
                    res.on('data', (chunk) => {
                        chunks.push(chunk);
                    });
                    
                    res.on('end', async () => {
                        try {
                            const responseData = Buffer.concat(chunks);
                            logger.debug(`直接HTTPSリクエスト完了: ${url}, ステータス=${res.statusCode}, サイズ=${responseData.length}バイト`);
                            
                            // 成功レスポンスの場合だけキャッシュに保存
                            if (res.statusCode === 200) {
                                // キャッシュデータを作成
                                const cacheHeader = {
                                    url: url,
                                    statusCode: res.statusCode,
                                    headers: res.headers,
                                };
                                
                                // 非同期でキャッシュを保存
                                try {
                                    await saveCache(cacheFile, cacheHeader, responseData);
                                    statsCollector.incrementHttpsStat('cacheSaves');
                                    logger.debug(`HTTPSレスポンスをキャッシュしました: ${url}`);
                                } catch (err) {
                                    logger.error('キャッシュ保存エラー:', err);
                                }
                            }
                            
                            resolve({
                                fromCache: false,
                                data: responseData,
                                headers: res.headers,
                                statusCode: res.statusCode
                            });
                        } catch (processErr) {
                            logger.error('レスポンス処理エラー:', processErr);
                            reject(processErr);
                        }
                    });
                });
                
                req.on('error', (err) => {
                    logger.error('直接HTTPSリクエストエラー:', err);
                    reject(err);
                });
                
                req.on('timeout', () => {
                    logger.error('直接HTTPSリクエストタイムアウト:', url);
                    req.destroy();
                    reject(new Error("リクエストがタイムアウトしました"));
                });
                
                req.end();
            } catch (reqError) {
                logger.error('HTTPSリクエスト作成エラー:', reqError);
                reject(reqError);
            }
        });
    });
}

// パッシブTLS分析をやめて単純に事前キャッシュを行う
async function prefetchDomainContent(domain) {
    if (!whitelistedDomains.has(domain)) {
        return null; // ホワイトリスト対象外はスキップ
    }

    const url = `https://${domain}/`;
    logger.info(`[事前キャッシュ] ${domain}のトップページを取得します: ${url}`);
    
    try {
        const response = await directHttpsRequest(url);
        logger.info(`[事前キャッシュ] ${domain}のトップページ取得完了: ${response.fromCache ? 'キャッシュから取得' : '新規取得'} (${response.data.length}バイト)`);
        return response;
    } catch (err) {
        logger.error(`[事前キャッシュ] ${domain}のトップページ取得に失敗: ${err.message}`);
        return null;
    }
}

// ホワイトリストにあるドメインへのHTTPS接続をプロキシするためにTLS終端を行う関数
function handleHTTPSProxy(clientSocket, targetHost, targetPort, head) {
    // クライアントソケットを追跡（既に追跡されている場合は冗長だが安全のため）
    trackConnection(clientSocket);
    
    logger.info(`TLS終端: ${targetHost}:${targetPort}`);
    
    try {
        // TLSサーバーオプションを設定
        const tlsOptions = {
            key: certManager.getPrivateKey(),
            cert: certManager.getCertificate(),
            requestCert: false,
            rejectUnauthorized: false
        };
        
        // TLSサーバーを作成
        const tlsServer = tls.createServer(tlsOptions, (tlsSocket) => {
            // TLSソケットを追跡
            trackConnection(tlsSocket);
            
            logger.debug(`TLS接続: ${targetHost}`);
            
            // HTTPSリクエスト処理
            tlsSocket.on('data', async (data) => {
                try {
                    const requestText = data.toString('utf8');
                    
                    // HTTPリクエスト形式の確認
                    if (requestText.match(/^(GET|POST|PUT|DELETE|HEAD|OPTIONS) .* HTTP\/\d\.\d/)) {
                        // リクエスト行とヘッダーを分離
                        const headersEndPos = requestText.indexOf('\r\n\r\n');
                        if (headersEndPos !== -1) {
                            const headerText = requestText.substring(0, headersEndPos);
                            const headerLines = headerText.split('\r\n');
                            const [method, path] = headerLines[0].split(' ').map(s => s.trim());
                            
                            // ホストヘッダーを取得
                            let host = targetHost;
                            for (let i = 1; i < headerLines.length; i++) {
                                if (headerLines[i].toLowerCase().startsWith('host:')) {
                                    host = headerLines[i].substring(5).trim();
                                    break;
                                }
                            }
                            
                            logger.debug(`リクエスト: ${method} ${host}${path}`);
                            
                            // URLを構築
                            const fullUrl = `https://${host}${path}`; // pathにはクエリパラメータも含まれる
                                                         
                            const cacheFile = getCacheFileName(fullUrl);
                            
                            // キャッシュの確認
                            try {
                                const exists = await fileExists(cacheFile);
                                if (exists) {
                                    const cache = await loadCache(cacheFile);
                                    if (cache && cache.data) {
                                        logger.info(`キャッシュヒット: ${fullUrl}`);
                                        statsCollector.incrementHttpsStat('cacheHits');
                                        
                                        // キャッシュからレスポンスを構築
                                        const responseData = Buffer.from(cache.data, 'base64');
                                        const headers = [];
                                        
                                        // レスポンスヘッダー構築
                                        headers.push(`HTTP/1.1 ${cache.statusCode} ${getStatusMessage(cache.statusCode)}`);
                                        
                                        // ヘッダー追加
                                        if (cache.headers) {
                                            Object.entries(cache.headers).forEach(([key, value]) => {
                                                if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
                                                    headers.push(`${key}: ${value}`);
                                                }
                                            });
                                        }
                                        
                                        // 追加ヘッダー
                                        headers.push('X-Cache: HIT');
                                        headers.push(`Content-Length: ${responseData.length}`);
                                        headers.push('Connection: close');
                                        headers.push('');
                                        headers.push('');
                                        
                                        // レスポンス送信
                                        tlsSocket.write(headers.join('\r\n'));
                                        tlsSocket.write(responseData);
                                        
                                        logger.debug(`キャッシュレスポンス: ${fullUrl}`);
                                        
                                        // キャッシュからのレスポンス送信後にソケットを閉じる
                                        setTimeout(() => {
                                            try {
                                                if (!tlsSocket.destroyed) {
                                                    tlsSocket.end();
                                                }
                                            } catch (endErr) {
                                                logger.error('TLSソケット終了エラー:', endErr);
                                            }
                                        }, 100);
                                        
                                        return;
                                    }
                                }
                                
                                // キャッシュが無い場合は直接リクエスト
                                logger.debug(`キャッシュミス: ${fullUrl}`);
                                statsCollector.incrementHttpsStat('cacheMisses');
                                
                                // HTTPSリクエスト作成
                                const options = {
                                    hostname: host,
                                    port: targetPort,
                                    path: path,
                                    method: method,
                                    headers: {},
                                    rejectUnauthorized: false
                                };
                                
                                // リクエストヘッダー設定
                                for (let i = 1; i < headerLines.length; i++) {
                                    const colonPos = headerLines[i].indexOf(':');
                                    if (colonPos > 0) {
                                        const name = headerLines[i].substring(0, colonPos).trim();
                                        const value = headerLines[i].substring(colonPos + 1).trim();
                                        options.headers[name] = value;
                                    }
                                }
                                
                                // リクエスト実行
                                const request = https.request(options, (response) => {
                                    logger.debug(`外部サーバーレスポンス: ${fullUrl}, ステータス=${response.statusCode}`);
                                    
                                    // レスポンスヘッダー送信
                                    let responseText = `HTTP/1.1 ${response.statusCode} ${response.statusMessage || getStatusMessage(response.statusCode)}\r\n`;
                                    Object.entries(response.headers).forEach(([key, value]) => {
                                        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
                                            responseText += `${key}: ${value}\r\n`;
                                        }
                                    });
                                    responseText += 'X-Cache: MISS\r\n';
                                    responseText += 'Connection: close\r\n\r\n';
                                    
                                    // ヘッダーを送信
                                    tlsSocket.write(responseText);
                                    
                                    // レスポンス本文取得用
                                    const chunks = [];
                                    
                                    response.on('data', (chunk) => {
                                        chunks.push(chunk);
                                        try {
                                            tlsSocket.write(chunk);
                                        } catch (err) {
                                            logger.error('レスポンスチャンク書き込みエラー:', err);
                                            // 書き込みエラーは無視して続行（接続が既に閉じられている可能性）
                                        }
                                    });
                                    
                                    response.on('end', async () => {
                                        try {
                                            const responseData = Buffer.concat(chunks);
                                            logger.debug(`レスポンス完了: ${fullUrl}, ステータス=${response.statusCode}, サイズ=${responseData.length}バイト`);
                                            
                                            // すべてのステータスコードをキャッシュ
                                            logger.info(`レスポンスキャッシュ対象: ${fullUrl}, ステータス=${response.statusCode}`);
                                            
                                            // キャッシュデータ作成
                                            const cacheHeader = {
                                                url: fullUrl,
                                                statusCode: response.statusCode,
                                                headers: response.headers,
                                            };
                                            
                                            // 非同期でキャッシュ保存
                                            try {
                                                await saveCache(cacheFile, cacheHeader, responseData);
                                                statsCollector.incrementHttpsStat('cacheSaves');
                                                logger.debug(`HTTPSレスポンスをキャッシュしました: ${fullUrl}`);
                                            } catch (err) {
                                                logger.error('キャッシュ保存エラー:', err);
                                            }
                                        } catch (err) {
                                            logger.error('レスポンス処理エラー:', err);
                                        }
                                        
                                        // レスポンス完了後にソケットを閉じる
                                        setTimeout(() => {
                                            try {
                                                if (!tlsSocket.destroyed) {
                                                    tlsSocket.end();
                                                }
                                            } catch (endErr) {
                                                logger.error('TLSソケット終了エラー:', endErr);
                                            }
                                        }, 100);
                                    });
                                    
                                    response.on('error', (err) => {
                                        logger.error(`レスポンスエラー: ${err.message}`);
                                        // エラーが発生してもソケットを閉じない
                                    });
                                });
                                
                                request.on('error', (err) => {
                                    logger.error(`外部サーバーリクエストエラー: ${err.message}`);
                                    
                                    const errorResponse = [
                                        'HTTP/1.1 502 Bad Gateway',
                                        'Content-Type: text/plain',
                                        'Connection: close',
                                        '',
                                        `エラー発生: ${err.message}`
                                    ].join('\r\n');
                                    
                                    tlsSocket.write(errorResponse);
                                });
                                
                                // リクエスト本文がある場合は転送
                                if (headersEndPos + 4 < requestText.length) {
                                    const body = requestText.substring(headersEndPos + 4);
                                    request.write(body);
                                }
                                
                                request.end();
                            } catch (err) {
                                logger.error('TLS経由リクエスト処理エラー:', err);
                                sendErrorResponse(tlsSocket, 500, 'Internal Server Error');
                                
                                // エラー時もソケットを閉じる
                                setTimeout(() => {
                                    try {
                                        if (!tlsSocket.destroyed) {
                                            tlsSocket.end();
                                        }
                                    } catch (endErr) {
                                        logger.error('TLSソケット終了エラー:', endErr);
                                    }
                                }, 100);
                            }
                        }
                    }
                } catch (err) {
                    logger.error('TLSデータ処理エラー:', err);
                    sendErrorResponse(tlsSocket, 500, 'Internal Server Error');
                    
                    // エラー時もソケットを閉じる
                    setTimeout(() => {
                        try {
                            if (!tlsSocket.destroyed) {
                                tlsSocket.end();
                            }
                        } catch (endErr) {
                            logger.error('TLSソケット終了エラー:', endErr);
                        }
                    }, 100);
                }
            });
            
            // エラーハンドリング改善
            tlsSocket.on('error', (err) => {
                logger.error('TLSソケットエラー:', err.message);
                // エラー発生時のチェック
                if (!tlsSocket.destroyed) {
                    try {
                        tlsSocket.end();
                    } catch (e) {
                        logger.error('TLSソケット終了エラー:', e.message);
                    }
                }
            });
            
            tlsSocket.on('end', () => {
                logger.info('TLSコネクション終了');
            });
        });
        
        // TLSサーバーエラーハンドリング
        tlsServer.on('error', (err) => {
            logger.error(`TLSサーバーエラー: ${err.message}`);
            if (!clientSocket.destroyed) {
                clientSocket.end();
            }
        });
        
        // 一時的なポートでTLSサーバー起動
        tlsServer.listen(0, () => {
            const tlsPort = tlsServer.address().port;
            logger.info(`TLSサーバーをポート ${tlsPort} で起動しました`);
            
            // クライアントに接続成功を通知
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n' +
                      'Connection: keep-alive\r\n' +
                      'Proxy-Agent: Node-Proxy/1.0\r\n\r\n', () => {
                logger.info('クライアントに接続確立を通知しました');
                
                // TLSサーバーへ接続
                const localConn = net.connect({
                    port: tlsPort,
                    host: 'localhost'
                }, () => {
                    logger.info(`ローカルTLSサーバーに接続: localhost:${tlsPort}`);
                    
                    // 双方向パイプを停止し、手動でデータの流れを制御
                    // clientSocket.pipe(localConn); 
                    // localConn.pipe(clientSocket);
                    
                    // 代わりに手動でデータを転送
                    clientSocket.on('data', (chunk) => {
                        try {
                            if (localConn.writable) {
                                const flushed = localConn.write(chunk);
                                if (!flushed) {
                                    clientSocket.pause();
                                    localConn.once('drain', () => {
                                        if (clientSocket.readable) clientSocket.resume();
                                    });
                                }
                            }
                        } catch (e) {
                            logger.error('クライアントからローカルへのデータ転送エラー:', e.message);
                        }
                    });
                    
                    localConn.on('data', (chunk) => {
                        try {
                            if (clientSocket.writable) {
                                const flushed = clientSocket.write(chunk);
                                if (!flushed) {
                                    localConn.pause();
                                    clientSocket.once('drain', () => {
                                        if (localConn.readable) localConn.resume();
                                    });
                                }
                            }
                        } catch (e) {
                            logger.error('ローカルからクライアントへのデータ転送エラー:', e.message);
                        }
                    });
                    
                    // ヘッダがあれば転送
                    if (head && head.length > 0) {
                        try {
                            localConn.write(head);
                        } catch (e) {
                            logger.error('ヘッダデータ転送エラー:', e.message);
                        }
                    }
                    
                    // クリーンアップ関数
                    const cleanup = () => {
                        try {
                            if (!clientSocket.destroyed) {
                                clientSocket.destroy();
                            }
                        } catch (e) {
                            logger.error('クライアントソケット破棄エラー:', e.message);
                        }
                        
                        try {
                            if (!localConn.destroyed) {
                                localConn.destroy();
                            }
                        } catch (e) {
                            logger.error('ローカル接続破棄エラー:', e.message);
                        }
                        
                        try {
                            if (tlsServer.listening) {
                                tlsServer.close(() => {
                                    logger.log(`TLSサーバー(ポート ${tlsPort})をクローズしました`);
                                });
                            }
                        } catch (e) {
                            logger.error('TLSサーバークローズエラー:', e.message);
                        }
                    };
                    
                    // エラーハンドリング
                    localConn.on('error', (err) => {
                        logger.error(`ローカル接続エラー: ${err.message}`);
                        cleanup();
                    });
                    
                    clientSocket.on('error', (err) => {
                        logger.error(`クライアント接続エラー: ${err.message}`);
                        cleanup();
                    });
                    
                    // 接続終了処理
                    localConn.on('end', () => {
                        logger.info('ローカル接続が終了しました');
                        try {
                            if (!clientSocket.destroyed) clientSocket.end();
                        } catch (e) {
                            logger.error('クライアント終了処理エラー:', e.message);
                        }
                    });
                    
                    clientSocket.on('end', () => {
                        logger.info('クライアント接続が終了しました');
                        try {
                            if (!localConn.destroyed) localConn.end();
                        } catch (e) {
                            logger.error('ローカル終了処理エラー:', e.message);
                        }
                    });
                    
                    // クローズ処理
                    localConn.on('close', () => {
                        logger.info('ローカル接続がクローズされました');
                        try {
                            if (!clientSocket.destroyed) clientSocket.end();
                        } catch (e) {
                            logger.error('クライアント終了処理エラー:', e.message);
                        }
                        
                        try {
                            if (tlsServer.listening) {
                                tlsServer.close(() => {
                                    logger.info(`TLSサーバー(ポート ${tlsPort})をクローズしました`);
                                });
                            }
                        } catch (e) {
                            logger.error('TLSサーバークローズエラー:', e.message);
                        }
                    });
                    
                    clientSocket.on('close', () => {
                        logger.info('クライアント接続がクローズされました');
                        try {
                            if (!localConn.destroyed) localConn.end();
                        } catch (e) {
                            logger.error('ローカル終了処理エラー:', e.message);
                        }
                        
                        // サーバーをクローズ
                        try {
                            if (tlsServer.listening) {
                                tlsServer.close(() => {
                                    logger.info(`TLSサーバー(ポート ${tlsPort})をクローズしました`);
                                });
                            }
                        } catch (e) {
                            logger.error('TLSサーバークローズエラー:', e.message);
                        }
                    });
                });
                
                // 接続エラー処理
                localConn.on('error', (err) => {
                    logger.error(`ローカルTLSサーバーへの接続エラー: ${err.message}`);
                    if (!clientSocket.destroyed) {
                        clientSocket.end();
                    }
                    
                    try {
                        tlsServer.close(() => {
                            logger.info(`TLSサーバー(ポート ${tlsPort})をクローズしました`);
                        });
                    } catch (e) {
                        logger.error('TLSサーバークローズエラー:', e.message);
                    }
                });
            });
        });
    } catch (err) {
        logger.error(`TLS終端処理エラー: ${err.message}`);
        if (!clientSocket.destroyed) {
            clientSocket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
            clientSocket.end();
        }
    }
}

// HTTPステータスコードに対応するメッセージを取得するヘルパー関数
function getStatusMessage(statusCode) {
    const statusMessages = {
        200: 'OK',
        201: 'Created',
        202: 'Accepted',
        204: 'No Content',
        301: 'Moved Permanently',
        302: 'Found',
        304: 'Not Modified',
        400: 'Bad Request',
        401: 'Unauthorized',
        403: 'Forbidden',
        404: 'Not Found',
        405: 'Method Not Allowed',
        500: 'Internal Server Error',
        501: 'Not Implemented',
        502: 'Bad Gateway',
        503: 'Service Unavailable',
        504: 'Gateway Timeout'
    };
    
    return statusMessages[statusCode] || 'Unknown';
}

// エラーレスポンスを送信するヘルパー関数
function sendErrorResponse(socket, statusCode, message) {
    if (!socket || socket.destroyed) return;
    
    try {
        const response = [
            `HTTP/1.1 ${statusCode} ${getStatusMessage(statusCode)}`,
            'Content-Type: text/plain',
            `Content-Length: ${Buffer.byteLength(message)}`,
            'Connection: close',
            '',
            message
        ].join('\r\n');
        
        socket.write(response);
    } catch (err) {
        logger.error('エラーレスポンス送信失敗:', err);
    }
}

// 単純な透過トンネル（ホワイトリスト対象外のドメイン用）
function createTransparentTunnel(clientSocket, targetHost, targetPort, head) {
    // クライアントソケットを追跡（既に追跡されている場合は冗長だが安全のため）
    trackConnection(clientSocket);
    
    logger.info(`透過トンネル作成: ${targetHost}:${targetPort}`);
    
    const targetSocket = net.connect(targetPort, targetHost, () => {
        // ターゲットソケットを追跡
        trackConnection(targetSocket);
        
        logger.info(`ターゲット接続確立: ${targetHost}:${targetPort}`);
        
        // クライアントに成功を通知
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n' +
                      'Connection: keep-alive\r\n' +
                      'Proxy-Agent: Node-Proxy/1.0\r\n\r\n');
        
        // 効率的なデータ転送のための設定
        clientSocket.setTimeout(0);
        targetSocket.setTimeout(0);
        clientSocket.setNoDelay(true);
        targetSocket.setNoDelay(true);
        
        // 双方向データ転送
        targetSocket.pipe(clientSocket);
        clientSocket.pipe(targetSocket);
        
        // ヘッドデータがあれば転送
        if (head && head.length > 0) {
            targetSocket.write(head);
        }
        
        // クリーンアップ関数
        const cleanup = () => {
            try {
                if (!clientSocket.destroyed) {
                    clientSocket.destroy();
                }
            } catch (e) {
                logger.error('クライアントソケット破棄エラー:', e.message);
            }
            
            try {
                if (!targetSocket.destroyed) {
                    targetSocket.destroy();
                }
            } catch (e) {
                logger.error('ターゲットソケット破棄エラー:', e.message);
            }
        };
        
        // エラーハンドリング
        targetSocket.on('error', (err) => {
            logger.error(`ターゲットソケットエラー: ${err.message}`);
            cleanup();
        });
        
        clientSocket.on('error', (err) => {
            logger.error(`クライアントソケットエラー: ${err.message}`);
            cleanup();
        });
        
        // 接続終了処理
        targetSocket.on('end', () => {
            logger.info(`ターゲット接続が終了しました: ${targetHost}`);
            if (!clientSocket.destroyed) {
                try {
                    clientSocket.end();
                } catch (e) {
                    logger.error('クライアント終了処理エラー:', e.message);
                }
            }
        });
        
        clientSocket.on('end', () => {
            logger.info('クライアント接続が終了しました');
            if (!targetSocket.destroyed) {
                try {
                    targetSocket.end();
                } catch (e) {
                    logger.error('ターゲット終了処理エラー:', e.message);
                }
            }
        });
        
        // クローズ処理
        targetSocket.on('close', () => {
            logger.info(`ターゲット接続がクローズされました: ${targetHost}`);
            if (!clientSocket.destroyed) {
                try {
                    clientSocket.end();
                } catch (e) {
                    logger.error('クライアント終了処理エラー:', e.message);
                }
            }
        });
        
        clientSocket.on('close', () => {
            logger.info('クライアント接続がクローズされました');
            if (!targetSocket.destroyed) {
                try {
                    targetSocket.end();
                } catch (e) {
                    logger.error('ターゲット終了処理エラー:', e.message);
                }
            }
        });
    });
    
    // 接続エラー処理
    targetSocket.on('error', (err) => {
        logger.error(`ターゲット接続エラー: ${err.message}`);
        if (!clientSocket.destroyed) {
            try {
                clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
                clientSocket.end();
            } catch (e) {
                logger.error('エラー応答送信失敗:', e.message);
            }
        }
    });
}

// URLからキャッシュファイル名を生成する関数をローカルではなく、グローバルにする
const getCacheFileName = (requestUrl, headers = {}) => {
    return cacheManager.getCacheFileName(requestUrl, headers);
};

// ファイルが存在するか確認するヘルパー関数
const fileExists = async (filePath) => {
    return cacheManager.fileExists(filePath);
};