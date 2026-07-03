/**
 * チュートリアル動画リンクの解決ヘルパー (Phase 3 オンボーディング / docs/smb-dx-pivot-plan.md §4)。
 *
 * 動画 URL は環境変数 TUTORIAL_VIDEO_URL で設定する任意項目。未設定の間は該当セクションを
 * 表示しない (壊れた/存在しないリンクを出さない graceful degradation)。設定値が http(s) 以外の
 * scheme (例: javascript:) だった場合も同様に握りつぶして null を返す (§9 出力のサニタイズ)。
 */

// チュートリアル動画の URL を取得する。未設定・不正な URL のときは null を返す
export function getTutorialVideoUrl(): string | null {
  // 前後空白を除去してから空判定する (".env で TUTORIAL_VIDEO_URL=' ' " などを未指定扱い)
  const raw = process.env.TUTORIAL_VIDEO_URL?.trim();
  // 未設定または空白だけなら「動画なし」として null を返す (呼び出し側でセクション自体を隠す)
  if (!raw) return null;

  // URL として解釈できることを WHATWG URL パーサで検証する
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // 壊れた URL はログに残し、危険なリンクを描画しないよう null にフォールバックする
    console.warn(`[tutorial-video] TUTORIAL_VIDEO_URL の形式が不正です: "${raw}"`);
    return null;
  }
  // http/https 以外の scheme (javascript: など) は出力しない
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.warn(`[tutorial-video] TUTORIAL_VIDEO_URL の scheme が不正です: "${parsed.protocol}"`);
    return null;
  }
  // 検証済みの URL 文字列を返す
  return raw;
}
