/**
 * ホワイトリスト管理クラス - ドメインとパターンの管理
 */
class WhitelistManager {
    /**
     * WhitelistManager コンストラクタ
     * @param {Object} logger ロガーインスタンス
     */
    constructor(logger) {
        this.logger = logger;
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
                        this.logger.log(`正規表現パターンをホワイトリストに追加: ${pattern}`);
                    } catch (err) {
                        this.logger.error(`無効な正規表現パターン: ${pattern}`, err);
                    }
                } else {
                    // 通常のドメイン名の場合
                    this.domains.add(domain);
                    this.logger.log(`ドメインをホワイトリストに追加: ${domain}`);
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
                this.logger.info(`正規表現パターンにマッチしました: ${cleanHost} -> ${regex}`);
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

module.exports = WhitelistManager;
