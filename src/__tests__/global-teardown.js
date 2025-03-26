const { spawn } = require('child_process');

// サーバーを安全に終了させる関数
const safelyKillServer = async () => {
  if (!global.proxyServer) return;
  
  return new Promise(resolve => {
    try {
      const isWin = process.platform === 'win32';
      
      if (isWin) {
        const killed = spawn('taskkill', ['/pid', global.proxyServer.pid, '/f', '/t']);
        killed.on('close', () => {
          console.log('プロキシサーバープロセスを終了しました');
          resolve();
        });
        killed.on('error', (err) => {
          console.error(`プロキシサーバー終了エラー: ${err}`);
          resolve();
        });
      } else {
        global.proxyServer.kill('SIGKILL');
        resolve();
      }
    } catch (err) {
      console.error('プロセス終了中にエラーが発生しました:', err);
      resolve();
    }
  });
};

// グローバルティアダウン
module.exports = async () => {
  console.log('グローバルティアダウン実行中...');
  await safelyKillServer();
  console.log('グローバルティアダウン完了');
};
