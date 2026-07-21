// Route Handler (Next.js API ルート) 向けの同一オリジン検証ヘルパー。
// /code-review ultra 指摘対応 (2026-07-21): Server Action は Next.js の組み込み Origin 検証で
// クロスサイト POST から保護されるが、POST /api/tickets・POST /api/tickets/[id]/comments は
// Server Action の既定 1MB ボディ上限を回避するため意図的に切り出した通常の Route Handler で、
// この保護を受けない。CLAUDE.md §9「フォーム送信や書き込み系 API には CSRF トークン
// （またはダブルサブミットクッキー）を必須とする」に反していたため、magic-link/callback/route.ts
// に個別実装されていた同一オリジン判定ロジックをここへ共通化する
// (CLAUDE.md §6「2〜3 箇所目で共通化する」の基準を満たす: magic-link + tickets + comments の3箇所)。

// リクエストが同一オリジンからの送信かどうかを判定する。
// 検証戦略 (優先順):
//   1. Sec-Fetch-Site ヘッダ (Chrome 76+ / Firefox 90+): ブラウザが必ず付与し
//      JavaScript から偽造できない Fetch Metadata ヘッダ。'same-origin' のみ許可する。
//   2. Origin ヘッダ (Sec-Fetch-Site を送らない Safari 等): scheme+host+port を
//      正規化して比較する。ブラウザが送信する 'null' 文字列 (file:// 等) は拒否する。
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
    // URL パースで scheme+host+port を正規化してから比較する (末尾スラッシュ等の揺れを吸収)
    return new URL(origin).origin === serverOrigin;
  } catch {
    // 不正な URL 文字列は fail-closed で拒否する
    return false;
  }
}
