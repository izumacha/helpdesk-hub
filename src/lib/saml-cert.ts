// Phase 4 Enterprise: SAML 証明書の正規化ヘルパー (純粋関数)。
// SAML SP コア (src/lib/saml.ts) と SSO 設定保存 (update-sso-config.ts) の双方で使うため、
// node-saml に依存しない独立モジュールに切り出して重複を避ける (DRY)。

// PEM 形式の証明書から base64 本体だけを取り出す。
// node-saml は base64 本体を期待し、DB にも base64 本体で保存するため正規化する。
// 既に base64 本体だけが渡された場合はヘッダが無いのでそのまま空白除去して返す。
export function normalizeCert(cert: string): string {
  // BEGIN/END CERTIFICATE 行を除去し、すべての空白 (改行含む) を取り除く
  return cert
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '')
    .trim();
}
