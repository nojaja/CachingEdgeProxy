const fs = require('fs');

/**
 * プロキシの統計情報を収集するクラス
 */
class StatisticsCollector {
    /**
     * StatisticsCollector コンストラクタ
     * @param {Object} logger ロガーインスタンス
     */
    constructor(logger) {
        this.logger = logger;
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
            this.logger.info(`アクティブ接続が削除されました。残り: ${this.activeConnections.size}`);
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
        this.logger.info('==== キャッシュ利用状況 ====');
        this.logger.info(`HTTP キャッシュヒット: ${this.http.cacheHits}, ミス: ${this.http.cacheMisses}`);
        this.logger.info(`HTTPS キャッシュヒット: ${this.https.cacheHits}, ミス: ${this.https.cacheMisses}, 保存: ${this.https.cacheSaves}`);
        this.logger.info(`アクティブ接続数: ${this.activeConnections.size}`);
        
        this.logger.info('==== プロキシ統計情報 ====');
        this.logger.info(`HTTP: ${this.http.requests}件, HTTPS: ${this.https.requests}件`);
        this.logger.info(`キャッシュヒット: ${this.http.cacheHits + this.https.cacheHits}, ミス: ${this.http.cacheMisses + this.https.cacheMisses}, 保存: ${this.https.cacheSaves}`);
    }
    
    /**
     * キャッシュファイル数をログに出力
     * @param {string} cacheDir キャッシュディレクトリパス
     */
    async logCacheFileCount(cacheDir) {
        try {
            const files = await fs.promises.readdir(cacheDir);
            this.logger.info(`キャッシュファイル数: ${files.length}`);
        } catch (err) {
            this.logger.error('キャッシュディレクトリ読み取りエラー:', err);
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

module.exports = StatisticsCollector;
