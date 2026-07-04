// SSRF (Server-Side Request Forgery) 対策ユーティリティ。
// 管理者が登録する Webhook URL などサーバー側で fetch するユーザー由来の URL を
// 内部ネットワーク・ループバック・クラウドメタデータへ誤って送信しないよう検証する。
// CLAUDE.md §9「サーバー側の外向きリクエストを検証する（SSRF 対策）」準拠。

// DNS 解決を行い、接続直前に解決済み IP を検証する Dispatcher を作るために使う
import dns from 'node:dns';
// dns.lookup のオプション/コールバック型 (net.LookupFunction と同じ形に合わせるため)
import type { LookupAddress, LookupOptions } from 'node:dns';
// undici の Agent (Dispatcher) — Node 標準 fetch に接続先解決ロジックを差し込むために使う
import { Agent } from 'undici';

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

// SSRF 対策済みの undici Dispatcher (Agent)。
//
// なぜこれが必要か: isUnsafeUrl によるホスト名文字列の検証は「保存時」と「送信直前」に
// 行っているが、どちらも「検証した時点でそのホスト名が指す IP」までは見ていない。
// 攻撃者 (悪意あるテナント管理者) が一度パブリック IP に解決されるドメインを Webhook URL
// として登録して両チェックを通過させたあと、TTL の短い DNS レコードを内部 IP
// (169.254.169.254 のクラウドメタデータ等) へ差し替える「DNS リバインディング」を行うと、
// 実際に fetch() が接続する IP はチェック時とは別物になり得る (チェックと接続の間の
// TOCTOU: Time-Of-Check-Time-Of-Use の空白)。
//
// この Dispatcher は実際に TCP 接続する直前、DNS で解決した「その IP」を検証すること
// で、チェックと接続を同一タイミングにし、上記の空白を無くす。
//
// Agent のコンストラクタに直接クロージャを書かずここで名前付き関数として切り出しているのは、
// ユニットテストから (実際に TCP 接続せず) dns.lookup をモックして直接呼び出せるようにするため。
export const ssrfSafeLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
): void => {
  // 実際の名前解決は Node 標準の dns.lookup に委譲する。呼び出し元が要求した形式
  // (options.all の有無で単一アドレス / 配列のどちらを返すか) をそのまま尊重して渡す。
  // ここで独自に all: true を強制すると、呼び出し元が単一アドレス形式を期待している
  // 場合に形が食い違い、接続処理側で予期しない不具合につながる恐れがあるため避ける。
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) {
      // DNS解決自体が失敗した場合はそのままエラーとして伝播する
      callback(err, address, family);
      return;
    }
    // 単一アドレス / 配列のどちらの形で返ってきても、検証は配列に正規化してまとめて行う
    const resolved: LookupAddress[] = Array.isArray(address)
      ? address
      : [{ address, family: family ?? 0 }];
    // 解決された IP のうち 1 つでも内部/ループバック/リンクローカルなら、
    // DNS ラウンドロビンや rebind 経由の迂回を防ぐため一括で接続を拒否する (fail-closed)
    const unsafe = resolved.find((entry) => isPrivateHost(entry.address));
    if (unsafe) {
      callback(
        new Error(`SSRFガード: 解決先アドレス ${unsafe.address} への接続は許可されません`),
        address,
        family,
      );
      return;
    }
    // 検証済みなので、実際に接続する IP として (呼び出し元が要求した形式のまま) 返す
    callback(null, address, family);
  });
};

// SSRF 対策済みの undici Dispatcher (Agent)。
// モジュール読み込み時に一度だけ生成し、コネクションプールとして使い回す
// (リクエストごとに new Agent() すると毎回別プールになり非効率なため)。
export const ssrfSafeDispatcher = new Agent({
  connect: { lookup: ssrfSafeLookup },
});
