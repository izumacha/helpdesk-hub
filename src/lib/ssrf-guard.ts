// SSRF (Server-Side Request Forgery) 対策ユーティリティ。
// 管理者が登録する Webhook URL などサーバー側で fetch するユーザー由来の URL を
// 内部ネットワーク・ループバック・クラウドメタデータへ誤って送信しないよう検証する。
// CLAUDE.md §9「サーバー側の外向きリクエストを検証する（SSRF 対策）」準拠。

// プライベート / ループバック / リンクローカル / CGNAT のホスト名を判定する関数。
// URL をパースした後の hostname 文字列 (IPv6 は "[...]" 括弧付き) を受け取る。
// DNS 名には対応していない (DNS リバインディングは別レイヤで対処)。
export function isPrivateHost(rawHostname: string): boolean {
  // IPv6 アドレスは URL 内で "[::1]" のように括弧で囲まれるため除去して比較する
  const h = rawHostname.toLowerCase();
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;

  // ─── ループバック ───────────────────────────────────────────────────────────
  // IPv4 ループバック: 127.0.0.0/8
  if (/^127\./.test(bare)) return true;
  // IPv6 ループバック: ::1
  if (bare === '::1') return true;
  // localhost (末尾ドット "localhost." はFQDN絶対表記として DNS リゾルバが受け入れる)
  if (/^localhost\.?$/.test(bare)) return true;

  // ─── リンクローカル ─────────────────────────────────────────────────────────
  // IPv4 リンクローカル: 169.254.0.0/16 (AWS IMDS 169.254.169.254 を含む)
  if (/^169\.254\./.test(bare)) return true;
  // IPv6 リンクローカル: fe80::/10 (fe80 ～ febf)
  if (/^fe[89ab]/i.test(bare)) return true;

  // ─── プライベートアドレス ────────────────────────────────────────────────────
  // 10.0.0.0/8
  if (/^10\./.test(bare)) return true;
  // 172.16.0.0/12 (172.16.x.x ～ 172.31.x.x)
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(bare)) return true;
  // 192.168.0.0/16
  if (/^192\.168\./.test(bare)) return true;
  // IPv6 ULA: fc00::/7 (fc00:: ～ fdff::)
  if (/^f[cd]/i.test(bare)) return true;

  // ─── その他の特殊アドレス ────────────────────────────────────────────────────
  // ANY-ADDRESS (0.0.0.0)
  if (bare === '0.0.0.0') return true;
  // CGNAT: 100.64.0.0/10 (AWS NLB 内部 IP 等で使われる共有アドレス空間)
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(bare)) return true;

  // ─── IPv6-mapped IPv4 ────────────────────────────────────────────────────────
  // ::ffff:x.x.x.x 形式のアドレスは IPv4 へのマッピング。
  // プライベート IPv4 全域が ::ffff: プレフィックスで到達可能になるため一括ブロック。
  // 例: ::ffff:7f00:1 = 127.0.0.1, ::ffff:a9fe:a9fe = 169.254.169.254
  if (/^::ffff:/i.test(bare)) return true;
  // 展開形式の IPv6-mapped IPv4 ("0:0:0:0:0:ffff:x.x.x.x") もブロックする。
  // 圧縮形式 "::ffff:" は上のチェックで捕捉済みだが、URL パーサが展開形式を返す場合は
  // 上のチェックをすり抜けるため、ここで別途チェックする。
  // 例: "0:0:0:0:0:ffff:192.168.1.1" → IPv4 アドレス 192.168.1.1 に到達する
  if (/^(?:0+:){5}ffff:/i.test(bare)) return true;

  // 上記に該当しない場合はパブリックホストとみなす
  return false;
}

// URL 文字列を受け取り、SSRF ガードをかけた上で安全かどうかを返す関数。
// parse エラー時は fail-closed で true (= unsafe) を返す。
export function isUnsafeUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // URL として解析できない場合は危険と判定する
    return true;
  }
  // https:// 以外のスキーム (http, file, ftp, etc.) は拒否する
  if (parsed.protocol !== 'https:') return true;
  // プライベートホストへのリクエストは拒否する
  return isPrivateHost(parsed.hostname);
}
