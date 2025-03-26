const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const net = require('net');
const execAsync = promisify(exec);

// グローバル変数
let proxyServer;
let proxyPort;

// 設定パス
const CONFIG_PATH = path.join(__dirname, '../../config/proxy-config.json');
const CACHE_DIR = path.join(__dirname, '../../cache');

// 空きポートを見つける関数
const findAvailablePort = async (startPort = 8300) => {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => {
      // ポートが使用中の場合、次のポートを試す
      resolve(findAvailablePort(startPort + 1));
    });
    server.listen(startPort, () => {
      server.close(() => {
        resolve(startPort);
      });
    });
  });
};

// サーバーが起動するまで待つ関数
const waitForServerReady = async (port, timeoutMs = 15000) => {
  const startTime = Date.now();
  let lastError;
  
  while (Date.now() - startTime < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const socket = new net.Socket();
        const onError = (err) => {
          socket.destroy();
          reject(err);
        };
        
        socket.setTimeout(1000);
        socket.once('error', onError);
        socket.once('timeout', () => onError(new Error('Connection timeout')));
        
        socket.connect(port, '127.0.0.1', () => {
          socket.destroy();
          resolve();
        });
      });
      
      // 接続成功、さらに少し待ってサーバーの初期化を待つ
      await new Promise(resolve => setTimeout(resolve, 2000));
      return true;
    } catch (error) {
      lastError = error;
      // 接続失敗、少し待ってリトライ
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  console.error(`サーバー起動タイムアウト: ${lastError?.message}`);
  return false;
};

// キャッシュと証明書ディレクトリをクリア
const cleanupCacheDir = async (dir) => {
  try {
    // ディレクトリの存在確認
    try {
      await fs.access(dir);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // ディレクトリが存在しない場合は作成して終了
        await fs.mkdir(dir, { recursive: true });
        return;
      }
      throw err;
    }
    
    // ファイルリストの取得
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    // 各エントリの削除を試みる
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      try {
        if (entry.isDirectory()) {
          // サブディレクトリの場合、再帰的に削除を試みる
          await cleanupCacheDir(fullPath);
          // 空になったディレクトリを削除
          await fs.rmdir(fullPath).catch(() => {});
        } else {
          // ファイルの場合、削除を試みる
          await fs.unlink(fullPath).catch(() => {});
        }
      } catch (err) {
        console.warn(`クリーンアップ警告: ${fullPath} - ${err.message}`);
        // エラーが発生しても他のファイルの処理を続行
      }
    }
  } catch (err) {
    console.warn(`ディレクトリクリーンアップ警告: ${dir} - ${err.message}`);
    // クリーンアップに失敗してもテストは続行
  }
};

// プロキシサーバーを起動する関数
async function setupProxyServer() {
  // 設定を読み込み
  const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  
  // キャッシュと証明書ディレクトリをクリア
  const cacheDir = path.join(__dirname, '../../cache');
  const certDir = path.dirname(config.https.certPath);
  
  // 改善されたクリーンアップ関数を使用
  await cleanupCacheDir(cacheDir);
  await cleanupCacheDir(certDir);

  // 証明書ディレクトリを作成
  await fs.mkdir(certDir, { recursive: true });

  // 使用可能なポートを見つける
  global.proxyPort = await findAvailablePort();
  console.log(`テスト用ポート: ${global.proxyPort}を使用します`);

  // プロキシサーバーを起動
  global.proxyServer = spawn('node', [
    path.resolve(__dirname, '../index.js'),
    `--port=${global.proxyPort}`
  ], {
    env: {
      ...process.env,
      PORT: global.proxyPort.toString()
    }
  });

  // エラーログの監視
  global.proxyServer.stderr.on('data', (data) => {
    console.error(`Proxy server error: ${data}`);
  });

  // 出力ログの監視
  global.proxyServer.stdout.on('data', (data) => {
    console.log(`Proxy server output: ${data}`);
  });

  // サーバー起動を待機
  const isReady = await waitForServerReady(global.proxyPort);
  if (isReady) {
    console.log('Proxy server is ready');
  } else {
    throw new Error('プロキシサーバーの起動に失敗しました');
  }
}

// グローバルセットアップ
module.exports = async () => {
  console.log('グローバルセットアップ実行中...');
  await setupProxyServer();
  console.log('グローバルセットアップ完了');
};
