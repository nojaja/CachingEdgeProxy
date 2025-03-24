const forge = require('node-forge');
const fsPromises = require('fs').promises;
const path = require('path');

class CertificateManager {
    constructor(config) {
        this.config = config;
        this.certPath = config.certPath;
        this.keyPath = config.keyPath;
        this.cert = null;
        this.privateKey = null;
    }

    async initialize() {
        // 入力値の検証
        if (!this.certPath || !this.keyPath) {
            return Promise.reject(new Error('証明書と秘密鍵のパスは必須です'));
        }

        const certDir = path.dirname(this.certPath);
        const keyDir = path.dirname(this.keyPath);

        if (certDir !== keyDir) {
            return Promise.reject(new Error('証明書と秘密鍵は同じディレクトリに配置する必要があります'));
        }

        const parentDir = path.dirname(certDir);

        try {

            // 書き込み権限の確認
            try {
                await fsPromises.access(path.dirname(certDir), fsPromises.constants.W_OK);
            } catch (err) {
                throw new Error('証明書ディレクトリへの書き込み権限がありません');
            }

            // 証明書ディレクトリの作成
            await fsPromises.mkdir(certDir, { recursive: true });

            // 証明書と秘密鍵が既に存在するか確認
            const [certExists, keyExists] = await Promise.all([
                fsPromises.access(this.certPath).then(() => true).catch(() => false),
                fsPromises.access(this.keyPath).then(() => true).catch(() => false)
            ]);

            if (certExists && keyExists) {
                // 既存の証明書と秘密鍵を読み込み
                [this.cert, this.privateKey] = await Promise.all([
                    fsPromises.readFile(this.certPath),
                    fsPromises.readFile(this.keyPath)
                ]);
                console.log('証明書を読み込みました');
            } else {
                // 新しい証明書と秘密鍵を生成
                await this.generateCertificate();
                console.log('証明書を正常に生成しました');
            }
            // 全ての処理が成功したら true を返す
            return true;
        } catch (err) {
            if (err.code === 'ENOENT') {
                throw new Error('証明書ファイルが見つかりません');
            } else if (err.code === 'EACCES') {
                throw new Error('証明書ファイルへのアクセス権限がありません');
            } else {
                throw new Error(`証明書の初期化エラー: ${err.message}`);
            }
        }
    }

    async generateCertificate() {
        try {
            // RSAキーペアの生成
            const keys = forge.pki.rsa.generateKeyPair(2048);
            const cert = forge.pki.createCertificate();

            // 証明書の基本情報を設定
            cert.publicKey = keys.publicKey;
            cert.serialNumber = '01';
            cert.validity.notBefore = new Date();
            cert.validity.notAfter = new Date();
            cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

            // 証明書の属性を設定
            const attrs = [{
                name: 'commonName',
                value: 'Proxy CA'
            }, {
                name: 'countryName',
                value: 'JP'
            }, {
                name: 'organizationName',
                value: 'Proxy CA'
            }];

            cert.setSubject(attrs);
            cert.setIssuer(attrs);

            // 証明書の拡張設定
            cert.setExtensions([{
                name: 'basicConstraints',
                cA: true
            }, {
                name: 'keyUsage',
                keyCertSign: true,
                digitalSignature: true,
                nonRepudiation: true,
                keyEncipherment: true,
                dataEncipherment: true
            }, {
                name: 'extKeyUsage',
                serverAuth: true,
                clientAuth: true
            }, {
                name: 'subjectAltName',
                altNames: [
                    { type: 2, value: 'localhost' },
                    { type: 2, value: 'example.com' },
                    { type: 2, value: 'httpbin.org' },
                    { type: 2, value: '*.googleapis.com' }
                ]
            }]);

            // 証明書に署名
            cert.sign(keys.privateKey, forge.md.sha256.create());

            // PEM形式に変換
            this.cert = forge.pki.certificateToPem(cert);
            this.privateKey = forge.pki.privateKeyToPem(keys.privateKey);

            // 証明書を保存
            await this.saveCertificateAndKey();
            console.log('証明書を生成して保存しました');

        } catch (err) {
            throw new Error(`証明書の生成エラー: ${err.message}`);
        }
    }

    async saveCertificateAndKey() {
        try {
            // 証明書ディレクトリの作成
            const certDir = path.dirname(this.certPath);
            await fsPromises.mkdir(certDir, { recursive: true });

            // 証明書と秘密鍵をBufferとして保存
            await Promise.all([
                fsPromises.writeFile(this.certPath, Buffer.from(this.cert)),
                fsPromises.writeFile(this.keyPath, Buffer.from(this.privateKey))
            ]);

            console.log('証明書と秘密鍵を保存しました');
            
            // 権限の設定
            await Promise.all([
                fsPromises.chmod(this.certPath, 0o600),
                fsPromises.chmod(this.keyPath, 0o600)
            ]);
        } catch (err) {
            throw new Error(`証明書の保存エラー: ${err.message}`);
        }
    }

    getCertificate() {
        return Buffer.isBuffer(this.cert) ? this.cert : Buffer.from(this.cert);
    }

    getPrivateKey() {
        return Buffer.isBuffer(this.privateKey) ? this.privateKey : Buffer.from(this.privateKey);
    }
}

module.exports = CertificateManager;
