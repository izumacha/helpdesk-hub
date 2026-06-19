/**
 * Application base-URL resolver (shared by magic-link & invitation links).
 *
 * メールに埋め込むリンクのベース URL を NEXTAUTH_URL から解決する純粋ヘルパー。
 * production で未設定だと「メールに http://localhost:3000 のリンクが入って開けない」
 * 事故になるため fail-fast する。マジックリンクと招待リンクの両方が使うため 1 か所に集約した。
 */

// production で NEXTAUTH_URL が未設定 / 空白だけ / 壊れた形式のときに投げるエラーメッセージ群。
// メッセージは既存のマジックリンク実装と同一にし、挙動・テスト互換性を保つ。
export function resolveAppBaseUrl(): string {
  // 前後空白を除去してから空判定する (".env で NEXTAUTH_URL=' ' " などを未指定扱い)
  const raw = process.env.NEXTAUTH_URL?.trim();
  // 未設定または空白だけの場合: 本番は即エラー、dev/test は localhost フォールバック
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('NEXTAUTH_URL is required in production to issue working email links');
    }
    return 'http://localhost:3000';
  }
  // URL として解釈できることを WHATWG URL パーサで検証する
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `NEXTAUTH_URL の形式が不正です ("${raw}"): http(s):// で始まる完全な URL を指定してください`,
    );
  }
  // scheme が http/https 以外 (例: file://) や、host が空の URL は弾く
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `NEXTAUTH_URL の scheme は http または https である必要があります (実際: ${parsed.protocol})`,
    );
  }
  if (!parsed.host) {
    throw new Error('NEXTAUTH_URL に host が含まれていません');
  }
  // バリデーション済みの URL 文字列を返す (末尾スラッシュ等の差異は呼び出し側 URL 構築で吸収)
  return raw;
}
