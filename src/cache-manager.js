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
     * @returns {Promise<boolean>} 保存成功したらtrue
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
            return true;
        } catch (err) {
            this.logger.error('キャッシュの保存エラー:', err);
            return false;
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
            
            // ファイルを読み込んでJSONとして解析 (.cacheファイル)
            try {
                const data = await fs.promises.readFile(`${cacheFile}.cache`, 'utf8');
                const cache = JSON.parse(data);
                
                // 必要なプロパティがすべて存在するか確認
                if (!cache.url || !cache.statusCode || !cache.headers || !cache.href) {
                    this.logger.warn(`キャッシュファイル形式不正: ${cacheFile} - 削除します`);
                    await fs.promises.unlink(cacheFile);
                    await fs.promises.unlink(`${cacheFile}.cache`);
                    return false;
                }
                
                // キャッシュファイルの存在チェック
                try {
                    const cacheDir = path.dirname(cacheFile);
                    const bodyFile = path.join(cacheDir, cache.href);
                    await fs.promises.access(bodyFile);
                } catch (accessErr) {
                    this.logger.warn(`キャッシュボディファイルが見つかりません: ${cacheFile} - 削除します`);
                    await fs.promises.unlink(`${cacheFile}.cache`);
                    return false;
                }
                
                return true;
            } catch (jsonErr) {
                // JSON解析エラー - ファイルが破損している
                this.logger.warn(`キャッシュファイルのJSON解析エラー: ${cacheFile} - 削除します`);
                await fs.promises.unlink(`${cacheFile}.cache`);
                try {
                    await fs.promises.unlink(cacheFile);
                } catch (e) {
                    // ファイルが既に存在しない場合は無視
                }
                return false;
            }
        } catch (err) {
            this.logger.error(`キャッシュファイルチェックエラー: ${cacheFile}`, err);
            
            // エラー発生時もファイル削除を試行
            try {
                await fs.promises.unlink(`${cacheFile}.cache`);
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
     * @param {number} maxFiles 一度に処理する最大ファイル数
     */
    async cleanupCorruptedCacheFiles(maxFiles = 100) {
        try {
            // キャッシュディレクトリが存在しない場合は作成
            await fs.promises.mkdir(this.CACHE_DIR, { recursive: true });
            
            // キャッシュディレクトリ内のすべてのファイルと再帰的にサブディレクトリを取得
            const getAllFiles = async (dir) => {
                const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
                const files = await Promise.all(dirents.map((dirent) => {
                    const res = path.resolve(dir, dirent.name);
                    return dirent.isDirectory() ? getAllFiles(res) : res;
                }));
                return files.flat();
            };
            
            const files = await getAllFiles(this.CACHE_DIR);
            
            // .cacheファイルのみをフィルタリング
            const cacheFiles = files.filter(file => file.endsWith('.cache'));
            
            let checkedCount = 0;
            let removedCount = 0;
            
            // ファイル数が多い場合はランダムに選択
            const filesToCheck = cacheFiles.length > maxFiles ? 
                cacheFiles.sort(() => Math.random() - 0.5).slice(0, maxFiles) : 
                cacheFiles;
            
            for (const cacheFile of filesToCheck) {
                checkedCount++;
                // キャッシュファイルのパスから.cacheを取り除いたパスを生成
                const dataFile = cacheFile.replace(/\.cache$/, '');
                
                const isValid = await this.checkAndRepairCacheFile(dataFile);
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
            // 再帰的にファイルを削除する関数
            const removeFiles = async (directory) => {
                try {
                    const files = await fs.promises.readdir(directory);
                    let deletedCount = 0;
                    const errors = [];

                    for (const file of files) {
                        const fullPath = path.join(directory, file);
                        const stats = await fs.promises.stat(fullPath);
                        
                        if (stats.isDirectory()) {
                            // 再帰的にディレクトリ内ファイルを削除
                            const result = await removeFiles(fullPath);
                            deletedCount += result.deletedCount;
                            errors.push(...result.errors);
                            
                            // 空になったディレクトリを削除
                            try {
                                await fs.promises.rmdir(fullPath);
                            } catch (err) {
                                errors.push(`ディレクトリ削除エラー ${fullPath}: ${err.message}`);
                            }
                        } else {
                            // ファイルを削除
                            try {
                                await fs.promises.unlink(fullPath);
                                deletedCount++;
                            } catch (err) {
                                errors.push(`${file}: ${err.message}`);
                            }
                        }
                    }

                    return { deletedCount, errors };
                } catch (err) {
                    return { deletedCount: 0, errors: [err.message] };
                }
            };
            
            const result = await removeFiles(this.CACHE_DIR);
            this.logger.info(`キャッシュクリア: ${result.deletedCount}ファイルを削除しました。エラー: ${result.errors.length}件`);
            return result;
        } catch (err) {
            this.logger.error('キャッシュクリアエラー:', err);
            throw err;
        }
    }

    /**
     * キャッシュの状態統計を取得
     * @returns {Promise<Object>} キャッシュ統計情報
     */
    async getCacheStats() {
        try {
            let totalFiles = 0;
            let totalSize = 0;
            
            const processDir = async (dir) => {
                try {
                    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                    
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        
                        if (entry.isDirectory()) {
                            await processDir(fullPath);
                        } else {
                            totalFiles++;
                            try {
                                const stats = await fs.promises.stat(fullPath);
                                totalSize += stats.size;
                            } catch (err) {
                                this.logger.error(`ファイル情報取得エラー: ${fullPath}`, err);
                            }
                        }
                    }
                } catch (err) {
                    this.logger.error(`ディレクトリ読み取りエラー: ${dir}`, err);
                }
            };
            
            await processDir(this.CACHE_DIR);
            
            return {
                totalFiles,
                totalSize,
                formattedSize: this.formatBytes(totalSize)
            };
        } catch (err) {
            this.logger.error('キャッシュ統計情報取得エラー:', err);
            return {
                totalFiles: 0,
                totalSize: 0,
                formattedSize: '0 B'
            };
        }
    }
    
    /**
     * バイト数を読みやすい形式に変換
     * @param {number} bytes バイト数
     * @param {number} decimals 小数点以下の桁数
     * @returns {string} フォーマットされたサイズ文字列
     */
    formatBytes(bytes, decimals = 2) {
        if (bytes === 0) return '0 B';
        
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }

    /**
     * URLがキャッシュされているか確認
     * @param {string} url 確認するURL
     * @returns {Promise<boolean>} キャッシュが存在すればtrue
     */
    async isCached(url) {
        const cacheFile = this.getCacheFileName(url);
        return await this.fileExists(`${cacheFile}.cache`);
    }

    /**
     * キャッシュを取得
     * @param {string} url 取得するURL
     * @returns {Promise<Object|null>} キャッシュオブジェクトまたはnull
     */
    async getCache(url) {
        const cacheFile = this.getCacheFileName(url);
        if (await this.fileExists(`${cacheFile}.cache`)) {
            return await this.loadCache(cacheFile);
        }
        return null;
    }
}

module.exports = CacheManager;
