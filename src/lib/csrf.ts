// Route Handler (Next.js API ルート) 向けの同一オリジン検証ヘルパー。
// /code-review ultra 指摘対応 (2026-07-21): Server Action は Next.js の組み込み Origin 検証で
// クロスサイト POST から保護されるが、POST /api/tickets・POST /api/tickets/[id]/comments は
// Server Action の既定 1MB ボディ上限を回避するため意図的に切り出した通常の Route Handler で、
// この保護を受けない。CLAUDE.md §9「フォーム送信や書き込み系 API には CSRF トークン
// （またはダブルサブミットクッキー）を必須とする」に反していたため、magic-link/callback/route.ts
// に個別実装されていた同一オリジン判定ロジックをここへ共通化する
// (CLAUDE.md §6「2〜3 箇所目で共通化する」の基準を満たす: magic-link + tickets + comments の3箇所)。

// 信頼できるアプリの公開ベース URL を解決する既存ヘルパー (NEXTAUTH_URL 由来) を再利用する
import { resolveAppBaseUrl } from '@/lib/app-url';

// 設定済みのアプリ公開オリジン (scheme+host+port) を取得する。
// 設計判断 (2026-07-22): TLS 終端するリバースプロキシ配下では request.url がプロキシ内部の
// http://... オリジンになる一方、ブラウザは公開側の https://... を Origin ヘッダに載せるため、
// request.url とだけ比較すると正規のクライアント (Sec-Fetch-Site 非対応の Safari 等) が
// 403 で誤拒否される。NEXTAUTH_URL 由来の resolveAppBaseUrl() を信頼できる公開オリジンとして
// 併用することでこの不一致を吸収する。
// 解決に失敗した場合 (本番で NEXTAUTH_URL 未設定・形式不正など) は null を返し、
// 呼び出し側は従来どおり request.url との比較のみで判定する (fail-closed / §9 fail-safe)。
function resolveTrustedAppOrigin(): string | null {
  try {
    // ベース URL を URL パースしてオリジン部分だけを正規化して返す
    return new URL(resolveAppBaseUrl()).origin;
  } catch {
    // 解決不能なら null (追加の許可を与えず従来動作に縮退する)
    return null;
  }
}

// リクエストが同一オリジンからの送信かどうかを判定する。
// 検証戦略 (優先順):
//   1. Sec-Fetch-Site ヘッダ (Chrome 76+ / Firefox 90+): ブラウザが必ず付与し
//      JavaScript から偽造できない Fetch Metadata ヘッダ。'same-origin' のみ許可する。
//   2. Origin ヘッダ (Sec-Fetch-Site を送らない Safari 等): scheme+host+port を
//      正規化し、request.url のオリジン、または NEXTAUTH_URL 由来の信頼済みアプリオリジン
//      (リバースプロキシ配下の内部/公開オリジン不一致対策) のどちらかに一致すれば許可する。
//      ブラウザが送信する 'null' 文字列 (file:// 等) は拒否する。
//   3. どちらも存在しない場合: fail-closed で拒否する (§9 fail-safe)。
export function isSameOriginRequest(request: Request): boolean {
  // Sec-Fetch-Site ヘッダは Chrome/Firefox が自動付与する Fetch Metadata ヘッダ (偽装不可)
  const secFetchSite = request.headers.get('sec-fetch-site');
  // サーバー側の正規オリジン (scheme + host + port) を取り出す
  const serverOrigin = new URL(request.url).origin;

  if (secFetchSite !== null) {
    // 'cross-site' は別ドメインからの送信 (CSRF 攻撃)、'same-site' は同一 eTLD+1 の
    // 別オリジン (許容しない)、'none' はダイレクトナビゲーション (form POST には通常
    // 現れない) なので、'same-origin' のみ許可する
    return secFetchSite === 'same-origin';
  }

  // Sec-Fetch-Site がない場合 (Safari 等): Origin ヘッダで同一オリジンを確認する
  const origin = request.headers.get('origin');
  // 'null' 文字列はブラウザが file:// や data: URL 等から送信する特殊な Origin 値。
  // 同一オリジンとは見なせないため拒否する
  if (!origin || origin === 'null') return false;
  try {
    // URL パースで scheme+host+port を正規化する (末尾スラッシュ等の揺れを吸収)
    const requestOrigin = new URL(origin).origin;
    // まずは request.url のオリジンと比較する (プロキシを介さない直接アクセスのケース)
    if (requestOrigin === serverOrigin) return true;
    // 一致しない場合はリバースプロキシ配下の可能性があるため、信頼済みアプリオリジンとも比較する
    const appOrigin = resolveTrustedAppOrigin();
    // アプリオリジンが解決でき、かつ一致した場合のみ許可する (解決不能時は従来どおり拒否)
    return appOrigin !== null && requestOrigin === appOrigin;
  } catch {
    // 不正な URL 文字列は fail-closed で拒否する
    return false;
  }
}
