const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

/**
 * キャッシュ管理クラス
 */
class CacheManager {
    /**
     * @param {string} cacheDir キャッシュディレクトリのパス
     * @param {Object} logger ロガーインスタンス
     */
    constructor(cacheDir, logger) {
        this.CACHE_DIR = cacheDir;
        this.logger = logger;
    }

    /**
     * キャッシュディレクトリを初期化
     */
    async initialize() {
        try {
            await fs.promises.mkdir(this.CACHE_DIR, { recursive: true });
            await fs.promises.chmod(this.CACHE_DIR, 0o777);
            this.logger.log('キャッシュディレクトリを初期化しました');
        } catch (err) {
            this.logger.error('キャッシュディレクトリの初期化エラー:', err);
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
            this.logger.error('URLの正規化エラー:', err, requestUrl);
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

            this.logger.debug('キャッシュをロードしました:', cache.url);
            return cache;
        } catch (err) {
            this.logger.error('キャッシュの読み込みエラー:', err);
            
            // キャッシュファイルが破損している場合は削除する
            try {
                this.logger.error(`破損したキャッシュファイルを削除: ${cacheFile}`);
                await fs.promises.unlink(cacheFile);
                await fs.promises.unlink(`${cacheFile}.cache`);
            } catch (unlinkErr) {
                this.logger.error('キャッシュファイル削除エラー:', unlinkErr);
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
            cacheHeader.href = filename;
            await fs.promises.writeFile(`${cacheFile}.cache`, JSON.stringify(cacheHeader, null, 2));
            await fs.promises.writeFile(cacheFile, body);
            await fs.promises.chmod(`${cacheFile}.cache`, 0o666);
            await fs.promises.chmod(cacheFile, 0o666);

            this.logger.debug('キャッシュを保存しました:', cacheHeader.url, `${cacheFile}.cache`,`${cacheFile}`);
        } catch (err) {
            this.logger.error('キャッシュの保存エラー:', err);
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
                    this.logger.warn(`キャッシュファイル形式不正: ${cacheFile} - 削除します`);
                    await fs.promises.unlink(cacheFile);
                    return false;
                }
                
                // Base64データをデコードしてみる
                try {
                    const decodedData = Buffer.from(cache.data, 'base64');
                    if (decodedData.length === 0 && cache.data.length > 0) {
                        // Base64デコードに失敗した可能性が高い
                        this.logger.warn(`キャッシュデータのBase64デコードに失敗: ${cacheFile} - 削除します`);
                        await fs.promises.unlink(cacheFile);
                        return false;
                    }
                } catch (decodeErr) {
                    this.logger.warn(`キャッシュデータのBase64デコードエラー: ${cacheFile} - 削除します`, decodeErr);
                    await fs.promises.unlink(cacheFile);
                    return false;
                }
                
                return true;
            } catch (jsonErr) {
                // JSON解析エラー - ファイルが破損している
                this.logger.warn(`キャッシュファイルのJSON解析エラー: ${cacheFile} - 削除します`);
                await fs.promises.unlink(cacheFile);
                return false;
            }
        } catch (err) {
            this.logger.error(`キャッシュファイルチェックエラー: ${cacheFile}`, err);
            
            // エラー発生時もファイル削除を試行
            try {
                await fs.promises.unlink(cacheFile);
                this.logger.warn(`エラーが発生したキャッシュファイルを削除: ${cacheFile}`);
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
                this.logger.info(`キャッシュ整合性チェック完了: ${checkedCount}ファイルをチェック、${removedCount}ファイルを削除`);
            }
        } catch (err) {
            this.logger.error('キャッシュクリーンアップエラー:', err);
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
            
            this.logger.info(`キャッシュクリア: ${deletedCount}ファイルを削除しました。エラー: ${errors.length}件`);
            return { deletedCount, errors };
        } catch (err) {
            this.logger.error('キャッシュクリアエラー:', err);
            throw err;
        }
    }
}

module.exports = CacheManager;
