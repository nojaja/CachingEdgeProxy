const LOG_LEVEL = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3
};

/**
 * ロガークラス - ログレベルに応じたロギング機能を提供
 */
class Logger {
    constructor(level = LOG_LEVEL.ERROR) {
        this.level = level;
    }

    /**
     * 現在のログレベルを設定
     * @param {number} level ログレベル
     */
    setLevel(level) {
        this.level = level;
    }

    /**
     * エラーログを出力
     * @param {string} message メッセージ
     * @param  {...any} args 追加の引数
     */
    error(message, ...args) {
        console.error(message, ...args);
    }

    /**
     * 警告ログを出力（WARNレベル以上）
     * @param {string} message メッセージ
     * @param  {...any} args 追加の引数
     */
    warn(message, ...args) {
        if (this.level >= LOG_LEVEL.WARN) {
            console.warn(message, ...args);
        }
    }

    /**
     * 情報ログを出力（INFOレベル以上）
     * @param {string} message メッセージ
     * @param  {...any} args 追加の引数
     */
    info(message, ...args) {
        if (this.level >= LOG_LEVEL.INFO) {
            console.log(message, ...args);
        }
    }

    /**
     * デバッグログを出力（DEBUGレベル）
     * @param {string} message メッセージ
     * @param  {...any} args 追加の引数
     */
    debug(message, ...args) {
        if (this.level >= LOG_LEVEL.DEBUG) {
            console.log(message, ...args);
        }
    }

    /**
     * 常に出力されるログ（ログレベルに関係なく）
     * @param {string} message メッセージ
     * @param  {...any} args 追加の引数
     */
    log(message, ...args) {
        console.log(message, ...args);
    }

    /**
     * コマンドライン引数または環境変数からログレベルを取得
     * @returns {number} ログレベル
     */
    static getLogLevelFromEnv() {
        // コマンドライン引数からログレベルを取得
        const args = process.argv.slice(2);
        for (const arg of args) {
            if (arg.startsWith('--log-level=')) {
                const level = arg.split('=')[1].toUpperCase();
                if (LOG_LEVEL.hasOwnProperty(level)) {
                    console.log(`コマンドライン引数からログレベルを設定: ${level}`);
                    return LOG_LEVEL[level];
                }
                
                // 数値での指定も許可
                const numLevel = parseInt(level, 10);
                if (!isNaN(numLevel) && numLevel >= 0 && numLevel <= 3) {
                    console.log(`コマンドライン引数からログレベルを設定: ${numLevel}`);
                    return numLevel;
                }
            }
        }
        
        // 環境変数からログレベルを取得
        if (process.env.LOG_LEVEL) {
            const level = process.env.LOG_LEVEL.toUpperCase();
            if (LOG_LEVEL.hasOwnProperty(level)) {
                console.log(`環境変数からログレベルを設定: ${level}`);
                return LOG_LEVEL[level];
            }
            
            // 数値での指定も許可
            const numLevel = parseInt(process.env.LOG_LEVEL, 10);
            if (!isNaN(numLevel) && numLevel >= 0 && numLevel <= 3) {
                console.log(`環境変数からログレベルを設定: ${numLevel}`);
                return numLevel;
            }
        }
        
        // デフォルトのロギングレベル
        return LOG_LEVEL.ERROR;
    }
}

// ロギングレベルを外部に公開
module.exports = {
    Logger,
    LOG_LEVEL
};
