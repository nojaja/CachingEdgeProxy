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

// ロガーのインスタンスを作成
const logger = new Logger(Logger.getLogLevelFromEnv());

/**
 * ホワイトリスト管理クラス
 */
class WhitelistManager {
    constructor() {
        this.domains = new Set();
        this.regexPatterns = [];
    }

    /**
     * 設定からホワイトリスト情報をロード
     * @param {Object} config 設定オブジェクト
     */
    loadFromConfig(config) {
        if (Array.isArray(config.whitelistedDomains)) {
            config.whitelistedDomains.forEach(domain => {
                if (domain.startsWith('regex:')) {
                    // 正規表現パターンの場合
                    const pattern = domain.substring(6); // 'regex:' を除去
                    try {
                        const regex = new RegExp(pattern, 'i'); // 大文字小文字を区別しない
                        this.regexPatterns.push(regex);
                        logger.log(`正規表現パターンをホワイトリストに追加: ${pattern}`);
                    } catch (err) {
                        logger.error(`無効な正規表現パターン: ${pattern}`, err);
                    }
                } else {
                    // 通常のドメイン名の場合
                    this.domains.add(domain);
                    logger.log(`ドメインをホワイトリストに追加: ${domain}`);
                }
            });
        }
    }

    /**
     * ホストがホワイトリストに含まれるかチェック
     * @param {string} host ホスト名
     * @returns {boolean} ホワイトリストに含まれる場合はtrue
     */
    isHostWhitelisted(host) {
        if (!host) return false;
        
        // ホスト名からポート部分を削除
        const cleanHost = host.split(':')[0];
        
        // 通常のホワイトリストをチェック
        if (this.domains.has(cleanHost)) {
            return true;
        }
        
        // 正規表現パターンをチェック
        for (const regex of this.regexPatterns) {
            if (regex.test(cleanHost)) {
                logger.info(`正規表現パターンにマッチしました: ${cleanHost} -> ${regex}`);
                return true;
            }
        }
        
        return false;
    }
    
    /**
     * ホワイトリストドメインをすべて取得
     * @returns {string[]} ドメイン配列
     */
    getAllDomains() {
        return Array.from(this.domains);
    }
    
    /**
     * 正規表現パターンをすべて取得
     * @returns {string[]} 正規表現パターン配列
     */
    getAllRegexPatterns() {
        return this.regexPatterns.map(r => r.toString());
    }
}

/**
 * キャッシュ管理クラス
 */
class CacheManager {
    /**
     * @param {string} cacheDir キャッシュディレクトリのパス
     */
    constructor(cacheDir) {
        this.CACHE_DIR = cacheDir;
    }

    /**
     * キャッシュディレクトリを初期化
     */
    async initialize() {
        try {
            await fs.promises.mkdir(this.CACHE_DIR, { recursive: true });
            await fs.promises.chmod(this.CACHE_DIR, 0o777);
            logger.log('キャッシュディレクトリを初期化しました');
        } catch (err) {
            logger.error('キャッシュディレクトリの初期化エラー:', err);
            throw err;
        }
    }
    
    /**
     * URLを正規化
     * @param {string} requestUrl リクエストURL
     * @param {Object} headers リクエストヘッダー
     * @returns {string} 正規化されたURL
     */
    normalizeUrl(requestUrl, headers = {}) {
        try {
            let url;
            if (requestUrl.startsWith('http://') || requestUrl.startsWith('https://')) {
                url = new URL(requestUrl);
            } else {
                const host = headers.host || 'localhost';
                url = new URL(requestUrl.startsWith('/') ? `http://${host}${requestUrl}` : `http://${host}/${requestUrl}`);
            }
            // クエリパラメータも含めて正規化URLを生成
            const normalized = `${url.protocol}//${url.host}${url.pathname}${url.search}`;
            return normalized;
        } catch (err) {
            logger.error('URLの正規化エラー:', err, requestUrl);
            throw err;
        }
    }
    
    /**
     * キャッシュファイル名を生成
     * @param {string} requestUrl リクエストURL
     * @param {Object} headers リクエストヘッダー
     * @returns {string} キャッシュファイルパス
     */
    getCacheFileName(requestUrl, headers = {}) {
        const normalizedUrl = this.normalizeUrl(requestUrl, headers);
        const hash = crypto.createHash('md5').update(normalizedUrl).digest('hex');
        const url = new URL(requestUrl);
        const filePath = url.pathname;
        
        const filenameWithExt = path.basename(filePath) || 'index.html';
        const filenameWithoutExt = path.parse(filenameWithExt).name;
        const extname = path.extname(filenameWithExt);
        const filename = `${filenameWithoutExt}-${hash}${extname}`;
        const dirPath = path.dirname(filePath);
        
        return path.join(this.CACHE_DIR, url.host, dirPath, `${filename}`);
    }
    
    /**
     * キャッシュをロード
     * @param {string} cacheFile キャッシュファイルのパス
     * @returns {Promise<Object|null>} キャッシュデータまたはnull
     */
    async loadCache(cacheFile) {
        try {
            const data = await fs.promises.readFile(`${cacheFile}.cache`, 'utf8');
            const cache = JSON.parse(data);
            if(cache.href){
                const cacheDir = path.dirname(cacheFile);
                const filename = path.join(cacheDir, cache.href);
                const body = await fs.promises.readFile(filename);
                cache.data = body.toString('base64');
            }

            logger.debug('キャッシュをロードしました:', cache.url);
            return cache;
        } catch (err) {
            logger.error('キャッシュの読み込みエラー:', err);
            
            // キャッシュファイルが破損している場合は削除する
            try {
                logger.error(`破損したキャッシュファイルを削除: ${cacheFile}`);
                await fs.promises.unlink(cacheFile);
                await fs.promises.unlink(`${cacheFile}.cache`);
            } catch (unlinkErr) {
                logger.error('キャッシュファイル削除エラー:', unlinkErr);
            }
            
            return null;
        }
    }
    
    /**
     * キャッシュを保存
     * @param {string} cacheFile キャッシュファイルパス
     * @param {Object} cacheHeader キャッシュヘッダー情報
     * @param {Buffer} body レスポンスボディ
     */
    async saveCache(cacheFile, cacheHeader, body) {
        try {
            const cacheDir = path.dirname(cacheFile);
            const filename = path.basename(cacheFile);
            await fs.promises.mkdir(cacheDir, { recursive: true });
            await fs.promises.chmod(cacheDir, 0o777);
            cacheHeader.href=filename;
            await fs.promises.writeFile(`${cacheFile}.cache`, JSON.stringify(cacheHeader, null, 2));
            await fs.promises.writeFile(cacheFile, body);
            await fs.promises.chmod(`${cacheFile}.cache`, 0o666);
            await fs.promises.chmod(cacheFile, 0o666);

            logger.debug('キャッシュを保存しました:', cacheHeader.url, `${cacheFile}.cache`,`${cacheFile}`);
        } catch (err) {
            logger.error('キャッシュの保存エラー:', err);
        }
    }
    
    /**
     * ファイルが存在するか確認
     * @param {string} filePath ファイルパス
     * @returns {Promise<boolean>} 存在すればtrue
     */
    async fileExists(filePath) {
        try {
            await fs.promises.access(filePath);
            return true;
        } catch (err) {
            return false;
        }
    }
    
    /**
     * キャッシュファイルの整合性をチェックして修復
     * @param {string} cacheFile キャッシュファイルパス
     * @returns {Promise<boolean>} 正常なら true
     */
    async checkAndRepairCacheFile(cacheFile) {
        try {
            // ファイルが存在するか確認
            const exists = await this.fileExists(cacheFile);
            if (!exists) {
                return false;
            }
            
            // ファイルを読み込んでJSONとして解析
            const data = await fs.promises.readFile(cacheFile, 'utf8');
            try {
                const cache = JSON.parse(data);
                
                // 必要なプロパティがすべて存在するか確認
                if (!cache.url || !cache.statusCode || !cache.headers || !cache.data) {
                    logger.warn(`キャッシュファイル形式不正: ${cacheFile} - 削除します`);
                    await fs.promises.unlink(cacheFile);
                    return false;
                }
                
                // Base64データをデコードしてみる
                try {
                    const decodedData = Buffer.from(cache.data, 'base64');
                    if (decodedData.length === 0 && cache.data.length > 0) {
                        // Base64デコードに失敗した可能性が高い
                        logger.warn(`キャッシュデータのBase64デコードに失敗: ${cacheFile} - 削除します`);
                        await fs.promises.unlink(cacheFile);
                        return false;
                    }
                } catch (decodeErr) {
                    logger.warn(`キャッシュデータのBase64デコードエラー: ${cacheFile} - 削除します`, decodeErr);
                    await fs.promises.unlink(cacheFile);
                    return false;
                }
                
                return true;
            } catch (jsonErr) {
                // JSON解析エラー - ファイルが破損している
                logger.warn(`キャッシュファイルのJSON解析エラー: ${cacheFile} - 削除します`);
                await fs.promises.unlink(cacheFile);
                return false;
            }
        } catch (err) {
            logger.error(`キャッシュファイルチェックエラー: ${cacheFile}`, err);
            
            // エラー発生時もファイル削除を試行
            try {
                await fs.promises.unlink(cacheFile);
                logger.warn(`エラーが発生したキャッシュファイルを削除: ${cacheFile}`);
            } catch (unlinkErr) {
                // 削除エラーは無視
            }
            
            return false;
        }
    }
    
    /**
     * 破損したキャッシュファイルをクリーンアップ
     */
    async cleanupCorruptedCacheFiles() {
        try {
            // キャッシュディレクトリ内のファイル一覧を取得
            const files = await fs.promises.readdir(this.CACHE_DIR);
            
            let checkedCount = 0;
            let removedCount = 0;
            
            // ファイル数が多い場合は一部だけチェック
            const filesToCheck = files.length > 100 ? 
                files.sort(() => Math.random() - 0.5).slice(0, 100) : // ランダムに100ファイルを選択
                files;
            
            for (const file of filesToCheck) {
                if (!file.endsWith('.cache')) continue;
                
                checkedCount++;
                const cacheFile = path.join(this.CACHE_DIR, file);
                
                const isValid = await this.checkAndRepairCacheFile(cacheFile);
                if (!isValid) {
                    removedCount++;
                }
            }
            
            if (removedCount > 0) {
                logger.info(`キャッシュ整合性チェック完了: ${checkedCount}ファイルをチェック、${removedCount}ファイルを削除`);
            }
        } catch (err) {
            logger.error('キャッシュクリーンアップエラー:', err);
        }
    }
    
    /**
     * キャッシュディレクトリ内のすべてのファイルをクリア
     */
    async clearAllCache() {
        try {
            const files = await fs.promises.readdir(this.CACHE_DIR);
            let deletedCount = 0;
            const errors = [];
            
            for (const file of files) {
                try {
                    await fs.promises.unlink(path.join(this.CACHE_DIR, file));
                    deletedCount++;
                } catch (unlinkErr) {
                    errors.push(`${file}: ${unlinkErr.message}`);
                }
            }
            
            logger.info(`キャッシュクリア: ${deletedCount}ファイルを削除しました。エラー: ${errors.length}件`);
            return { deletedCount, errors };
        } catch (err) {
            logger.error('キャッシュクリアエラー:', err);
            throw err;
        }
    }
}

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
const whitelistManager = new WhitelistManager();
whitelistManager.loadFromConfig(config);

// キャッシュディレクトリのパスを設定
const CACHE_DIR = path.join(__dirname, '..', 'cache');
const cacheManager = new CacheManager(CACHE_DIR);

// ホワイトリストドメインの設定からクラスを作成
const whitelistedDomains = whitelistManager.domains;
const whitelistedRegexPatterns = whitelistManager.regexPatterns;

// キャッシュディレクトリの初期化
const initializeCacheDir = async () => {
    try {
        await fs.promises.mkdir(CACHE_DIR, { recursive: true });
        await fs.promises.chmod(CACHE_DIR, 0o777);
        logger.log('キャッシュディレクトリを初期化しました');
    } catch (err) {
        logger.error('キャッシュディレクトリの初期化エラー:', err);
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
    try {
        const data = await fs.promises.readFile(`${cacheFile}.cache`, 'utf8');
        const cache = JSON.parse(data);
        if(cache.href){
            const cacheDir = path.dirname(cacheFile);
            const filename = path.join(cacheDir, cache.href);
            const body = await fs.promises.readFile(filename);
            cache.data = body.toString('base64');
        }

        logger.debug('キャッシュをロードしました:', cache.url);
        return cache;
    } catch (err) {
        logger.error('キャッシュの読み込みエラー:', err);
        
        // キャッシュファイルが破損している場合は削除する
        try {
            logger.error(`破損したキャッシュファイルを削除: ${cacheFile}`);
            await fs.promises.unlink(cacheFile);
            await fs.promises.unlink(`${cacheFile}.cache`);
        } catch (unlinkErr) {
            logger.error('キャッシュファイル削除エラー:', unlinkErr);
        }
        
        return null;
    }
};

// キャッシュの保存
const saveCache = async (cacheFile, cacheHeader, body) => {
    try {
        const cacheDir = path.dirname(cacheFile);
        const filename = path.basename(cacheFile);
        await fs.promises.mkdir(cacheDir, { recursive: true });
        await fs.promises.chmod(cacheDir, 0o777);
        cacheHeader.href=filename;
        await fs.promises.writeFile(`${cacheFile}.cache`, JSON.stringify(cacheHeader, null, 2));
        await fs.promises.writeFile(cacheFile, body);
        await fs.promises.chmod(`${cacheFile}.cache`, 0o666);
        await fs.promises.chmod(cacheFile, 0o666);

        logger.debug('キャッシュを保存しました:', cacheHeader.url, `${cacheFile}.cache`,`${cacheFile}`);
    } catch (err) {
        logger.error('キャッシュの保存エラー:', err);
    }
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
                    //data: responseData.toString('base64')
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
                    //data: bodyBuffer.toString('base64')
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

// 統計情報収集クラス
class StatisticsCollector {
    constructor() {
        this.http = {
            requests: 0,
            cacheHits: 0,
            cacheMisses: 0
        };
        
        this.https = {
            connections: 0,
            requests: 0,
            cacheHits: 0,
            cacheMisses: 0,
            cacheSaves: 0
        };
        
        this.activeConnections = new Set();
    }
    
    /**
     * アクティブな接続を追跡
     * @param {net.Socket} socket ソケットオブジェクト
     * @returns {net.Socket} 同じソケットオブジェクト
     */
    trackConnection(socket) {
        this.activeConnections.add(socket);
        
        // 接続が閉じられたときにセットから削除
        socket.once('close', () => {
            this.activeConnections.delete(socket);
            logger.info(`アクティブ接続が削除されました。残り: ${this.activeConnections.size}`);
        });
        
        return socket;
    }
    
    /**
     * HTTP統計情報の更新
     * @param {string} type 統計タイプ (requests|cacheHits|cacheMisses)
     * @param {number} value 増加量 (デフォルト: 1)
     */
    incrementHttpStat(type, value = 1) {
        if (this.http.hasOwnProperty(type)) {
            this.http[type] += value;
        }
    }
    
    /**
     * HTTPS統計情報の更新
     * @param {string} type 統計タイプ (connections|requests|cacheHits|cacheMisses|cacheSaves)
     * @param {number} value 増加量 (デフォルト: 1)
     */
    incrementHttpsStat(type, value = 1) {
        if (this.https.hasOwnProperty(type)) {
            this.https[type] += value;
        }
    }
    
    /**
     * 統計情報を取得
     * @returns {Object} 統計情報
     */
    getStats() {
        return {
            http: { ...this.http },
            https: { ...this.https },
            activeConnections: this.activeConnections.size,
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage()
        };
    }
    
    /**
     * 統計情報をログに出力
     */
    logStats() {
        logger.info('==== キャッシュ利用状況 ====');
        logger.info(`HTTP キャッシュヒット: ${this.http.cacheHits}, ミス: ${this.http.cacheMisses}`);
        logger.info(`HTTPS キャッシュヒット: ${this.https.cacheHits}, ミス: ${this.https.cacheMisses}, 保存: ${this.https.cacheSaves}`);
        logger.info(`アクティブ接続数: ${this.activeConnections.size}`);
        
        logger.info('==== プロキシ統計情報 ====');
        logger.info(`HTTP: ${this.http.requests}件, HTTPS: ${this.https.requests}件`);
        logger.info(`キャッシュヒット: ${this.http.cacheHits + this.https.cacheHits}, ミス: ${this.http.cacheMisses + this.https.cacheMisses}, 保存: ${this.https.cacheSaves}`);
    }
    
    /**
     * キャッシュファイル数をログに出力
     * @param {string} cacheDir キャッシュディレクトリパス
     */
    async logCacheFileCount(cacheDir) {
        try {
            const files = await fs.promises.readdir(cacheDir);
            logger.info(`キャッシュファイル数: ${files.length}`);
        } catch (err) {
            logger.error('キャッシュディレクトリ読み取りエラー:', err);
        }
    }
    
    /**
     * 定期的なログ出力を開始
     * @param {string} cacheDir キャッシュディレクトリパス
     */
    startPeriodicLogging(cacheDir) {
        // キャッシュ統計情報の定期出力（30秒ごと）
        setInterval(() => {
            this.logStats();
            this.logCacheFileCount(cacheDir);
        }, 30000);
    }
}

// 既存のstats変数とhttpsStats変数を置き換える
const statsCollector = new StatisticsCollector();

// 定期的な統計情報のログ出力を開始（既存の同様のコードは削除すること）
statsCollector.startPeriodicLogging(CACHE_DIR);

// 既存のtrackConnection関数を置き換える
// 新しい接続が確立されたときにセットに追加
function trackConnection(socket) {
    return statsCollector.trackConnection(socket);
}

// 下記の既存の変数と関連コードは削除すること（コメントアウトしておく）
// const stats = { ... }
// const httpsStats = { ... }
// const activeConnections = new Set();
// setInterval(() => { ... }, 30000); // 30秒ごとの統計出力
// setInterval(() => { ... }, 60000); // 1分ごとのプロキシ統計出力

// ホワイトリストの確認用ヘルパー関数 (正規表現対応版)
const isHostWhitelisted = (host) => {
    if (!host) return false;
    
    // ホスト名からポート部分を削除
    const cleanHost = host.split(':')[0];
    
    // 通常のホワイトリストをチェック
    if (whitelistedDomains.has(cleanHost)) {
        return true;
    }
    
    // 正規表現パターンをチェック
    for (const regex of whitelistedRegexPatterns) {
        if (regex.test(cleanHost)) {
            logger.info(`正規表現パターンにマッチしました: ${cleanHost} -> ${regex}`);
            return true;
        }
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
                                    //data: responseData.toString('base64')
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
                        //data: responseData.toString('base64')
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

// 統計とヘルスチェック用のエンドポイントを更新
server.on('request', (req, res) => {
    // 統計情報のAPIエンドポイント
    if (req.url === '/proxy-stats' && req.headers.host.includes('localhost')) {
        res.writeHead(200, {'Content-Type': 'application/json'});
        const statsData = {
            ...statsCollector.getStats(),
            whitelistedDomains: Array.from(whitelistedDomains),
            whitelistedRegexPatterns: whitelistedRegexPatterns.map(r => r.toString()),
        };
        res.end(JSON.stringify(statsData, null, 2));
        return;
    }
    
    // ヘルスチェックAPI
    if (req.url === '/health' && req.headers.host.includes('localhost')) {
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end('OK');
        return;
    }
});

// ホワイトリスト確認API（デバッグ用）
server.on('request', (req, res) => {
    // ... existing code ...

    // ホワイトリスト確認
    if (req.url === '/check-whitelist' && req.headers.host.includes('localhost')) {
        const host = req.headers['x-check-host'];
        if (host) {
            const isWhitelisted = isHostWhitelisted(host);
            
            // どのルールでマッチしたか確認
            let matchedBy = 'none';
            if (whitelistedDomains.has(host)) {
                matchedBy = 'exact';
            } else {
                for (const regex of whitelistedRegexPatterns) {
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
                whitelistedDomains: Array.from(whitelistedDomains),
                whitelistedRegexPatterns: whitelistedRegexPatterns.map(r => r.toString())
            }));
        } else {
            res.writeHead(400, {'Content-Type': 'text/plain'});
            res.end('X-Check-Host header is required');
        }
        return;
    }

    // キャッシュクリア
    if (req.url === '/clear-cache' && req.headers.host.includes('localhost')) {
        fs.readdir(CACHE_DIR, (err, files) => {
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
                    fs.unlinkSync(path.join(CACHE_DIR, file));
                    deleted++;
                } catch (unlinkErr) {
                    errors.push(`${file}: ${unlinkErr.message}`);
                }
            });
            
            res.writeHead(200, {'Content-Type': 'text/plain'});
            res.end(`${deleted}個のキャッシュファイルを削除しました。${errors.length > 0 ? `\nエラー: ${errors.join(', ')}` : ''}`);
        });
        return;
    }
});

// メインの説明ページのHTMLを更新
server.on('request', (req, res) => {
    if (req.url === '/' && req.headers.host.includes('localhost')) {
        res.writeHead(200, {'Content-Type': 'text/html'});
        const stats = statsCollector.getStats();
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
                        ${Array.from(whitelistedDomains).map(domain => `<li>${domain}</li>`).join('')}
                    </ul>
                    <h3>正規表現パターン:</h3>
                    <ul>
                        ${whitelistedRegexPatterns.map(regex => `<li>${regex.toString()}</li>`).join('')}
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
    }
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
                                                //data: responseData.toString('base64')
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
                            //data: bodyData.toString('base64')
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
                                    //data: responseData.toString('base64')
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
                                                //data: responseData.toString('base64')
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

// ユーティリティ関数：キャッシュファイルのエラーチェックと修復
async function checkAndRepairCacheFile(cacheFile) {
    try {
        // ファイルが存在するか確認
        const exists = await fileExists(cacheFile);
        if (!exists) {
            return false;
        }
        
        // ファイルを読み込んでJSONとして解析
        const data = await fs.promises.readFile(cacheFile, 'utf8');
        try {
            const cache = JSON.parse(data);
            
            // 必要なプロパティがすべて存在するか確認
            if (!cache.url || !cache.statusCode || !cache.headers || !cache.data) {
                logger.warn(`キャッシュファイル形式不正: ${cacheFile} - 削除します`);
                await fs.promises.unlink(cacheFile);
                return false;
            }
            
            // Base64データをデコードしてみる
            try {
                const decodedData = Buffer.from(cache.data, 'base64');
                if (decodedData.length === 0 && cache.data.length > 0) {
                    // Base64デコードに失敗した可能性が高い
                    logger.warn(`キャッシュデータのBase64デコードに失敗: ${cacheFile} - 削除します`);
                    await fs.promises.unlink(cacheFile);
                    return false;
                }
            } catch (decodeErr) {
                logger.warn(`キャッシュデータのBase64デコードエラー: ${cacheFile} - 削除します`, decodeErr);
                await fs.promises.unlink(cacheFile);
                return false;
            }
            
            return true;
        } catch (jsonErr) {
            // JSON解析エラー - ファイルが破損している
            logger.warn(`キャッシュファイルのJSON解析エラー: ${cacheFile} - 削除します`);
            await fs.promises.unlink(cacheFile);
            return false;
        }
    } catch (err) {
        logger.error(`キャッシュファイルチェックエラー: ${cacheFile}`, err);
        
        // エラー発生時もファイル削除を試行
        try {
            await fs.promises.unlink(cacheFile);
            logger.warn(`エラーが発生したキャッシュファイルを削除: ${cacheFile}`);
        } catch (unlinkErr) {
            // 削除エラーは無視
        }
        
        return false;
    }
}

// キャッシュディレクトリ内の破損ファイルを定期的にクリーンアップ
async function cleanupCorruptedCacheFiles() {
    try {
        // キャッシュディレクトリ内のファイル一覧を取得
        const files = await fs.promises.readdir(CACHE_DIR);
        
        let checkedCount = 0;
        let removedCount = 0;
        
        // ファイル数が多い場合は一部だけチェック
        const filesToCheck = files.length > 100 ? 
            files.sort(() => Math.random() - 0.5).slice(0, 100) : // ランダムに100ファイルを選択
            files;
        
        for (const file of filesToCheck) {
            if (!file.endsWith('.cache')) continue;
            
            checkedCount++;
            const cacheFile = path.join(CACHE_DIR, file);
            
            const isValid = await checkAndRepairCacheFile(cacheFile);
            if (!isValid) {
                removedCount++;
            }
        }
        
        if (removedCount > 0) {
            logger.info(`キャッシュ整合性チェック完了: ${checkedCount}ファイルをチェック、${removedCount}ファイルを削除`);
        }
    } catch (err) {
        logger.error('キャッシュクリーンアップエラー:', err);
    }
}

// 起動時に一度実行し、その後は定期的に破損キャッシュファイルをクリーンアップ
setTimeout(cleanupCorruptedCacheFiles, 10000); // 起動から10秒後に初回実行
setInterval(cleanupCorruptedCacheFiles, 1800000); // その後30分ごとに実行

// URLからキャッシュファイル名を生成する関数をローカルではなく、グローバルにする
const getCacheFileName = (requestUrl, headers = {}) => {
    try {
        let url;
        if (requestUrl.startsWith('http://') || requestUrl.startsWith('https://')) {
            url = new URL(requestUrl);
        } else {
            const host = headers.host || 'localhost';
            url = new URL(requestUrl.startsWith('/') ? `http://${host}${requestUrl}` : `http://${host}/${requestUrl}`);
        }
        // クエリパラメータも含めて正規化URLを生成
        const normalizedUrl = `${url.protocol}//${url.host}${url.pathname}${url.search}`;
        const hash = crypto.createHash('md5').update(normalizedUrl).digest('hex');
        const filePath = url.pathname;
        
        const filenameWithExt = path.basename(filePath) || 'index.html';
        const filenameWithoutExt = path.parse(filenameWithExt).name;
        const extname = path.extname(filenameWithExt);
        const filename = `${filenameWithoutExt}-${hash}${extname}`;
        const dirPath = path.dirname(filePath);
        
        return path.join(CACHE_DIR, url.host, dirPath, `${filename}`);
    } catch (err) {
        logger.error('URLの正規化エラー:', err, requestUrl);
        throw err;
    }
};

// ファイルが存在するか確認するヘルパー関数
const fileExists = async (filePath) => {
    try {
        await fs.promises.access(filePath);
        return true;
    } catch (err) {
        return false;
    }
};

// 統計とヘルスチェック用のエンドポイントを更新
server.on('request', (req, res) => {
    // 統計情報のAPIエンドポイント
    if (req.url === '/proxy-stats' && req.headers.host.includes('localhost')) {
        res.writeHead(200, {'Content-Type': 'application/json'});
        const statsData = {
            ...statsCollector.getStats(),
            whitelistedDomains: Array.from(whitelistedDomains),
            whitelistedRegexPatterns: whitelistedRegexPatterns.map(r => r.toString()),
        };
        res.end(JSON.stringify(statsData, null, 2));
        return;
    }
    
    // ヘルスチェックAPI
    if (req.url === '/health' && req.headers.host.includes('localhost')) {
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end('OK');
        return;
    }
});

// ホワイトリスト確認API（デバッグ用）
server.on('request', (req, res) => {
    // ホワイトリスト確認
    if (req.url === '/check-whitelist' && req.headers.host.includes('localhost')) {
        const host = req.headers['x-check-host'];
        if (host) {
            const isWhitelisted = isHostWhitelisted(host);
            
            // どのルールでマッチしたか確認
            let matchedBy = 'none';
            if (whitelistedDomains.has(host)) {
                matchedBy = 'exact';
            } else {
                for (const regex of whitelistedRegexPatterns) {
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
                whitelistedDomains: Array.from(whitelistedDomains),
                whitelistedRegexPatterns: whitelistedRegexPatterns.map(r => r.toString())
            }));
        } else {
            res.writeHead(400, {'Content-Type': 'text/plain'});
            res.end('X-Check-Host header is required');
        }
        return;
    }

    // キャッシュクリア
    if (req.url === '/clear-cache' && req.headers.host.includes('localhost')) {
        fs.readdir(CACHE_DIR, (err, files) => {
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
                    fs.unlinkSync(path.join(CACHE_DIR, file));
                    deleted++;
                } catch (unlinkErr) {
                    errors.push(`${file}: ${unlinkErr.message}`);
                }
            });
            
            res.writeHead(200, {'Content-Type': 'text/plain'});
            res.end(`${deleted}個のキャッシュファイルを削除しました。${errors.length > 0 ? `\nエラー: ${errors.join(', ')}` : ''}`);
        });
        return;
    }

    // キャッシュチェック
    if (req.url.startsWith('/check-cache') && req.headers.host.includes('localhost')) {
        const urlParam = new URL(`http://localhost${req.url}`).searchParams.get('url');
        if (!urlParam) {
            res.writeHead(400, {'Content-Type': 'text/plain'});
            res.end('url parameter is required');
            return;
        }
        
        const cacheFile = getCacheFileName(urlParam);
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
            
            loadCache(cacheFile)
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
        return;
    }
    
    // キャッシュ更新
    if (req.url.startsWith('/update-cache') && req.headers.host.includes('localhost')) {
        const urlParam = new URL(`http://localhost${req.url}`).searchParams.get('url');
        if (!urlParam) {
            res.writeHead(400, {'Content-Type': 'text/plain'});
            res.end('url parameter is required');
            return;
        }
        
        directHttpsRequest(urlParam)
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
        return;
    }
});

// メインの説明ページのHTMLを更新
server.on('request', (req, res) => {
    // 別のrequestハンドラで既に処理された場合は何もしない
    if (res.headersSent || res.writableEnded) {
        return;
    }

    if (req.url === '/' && req.headers.host.includes('localhost')) {
        res.writeHead(200, {'Content-Type': 'text/html'});
        const stats = statsCollector.getStats();
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
                        ${Array.from(whitelistedDomains).map(domain => `<li>${domain}</li>`).join('')}
                    </ul>
                    <h3>正規表現パターン:</h3>
                    <ul>
                        ${whitelistedRegexPatterns.map(regex => `<li>${regex.toString()}</li>`).join('')}
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
        return;
    }

    // ローカルホスト以外のリクエストは許可
    if (!req.headers.host.includes('localhost:8000')) {
        return;
    }

    // ローカルホストへの直接リクエストを拒否
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('直接のローカルホストへのリクエストは許可されていません');
});