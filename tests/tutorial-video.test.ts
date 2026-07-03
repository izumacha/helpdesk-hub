// チュートリアル動画リンク解決ヘルパーの単体テスト。
// 未設定・不正 URL・不正 scheme のときに null へ安全側フォールバックすることを検証する。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTutorialVideoUrl } from '@/lib/tutorial-video';

describe('getTutorialVideoUrl', () => {
  afterEach(() => {
    // 各テストで stub した環境変数を元に戻す
    vi.unstubAllEnvs();
  });

  // 未設定なら null (セクション非表示)
  it('未設定なら null を返す', () => {
    vi.stubEnv('TUTORIAL_VIDEO_URL', '');
    expect(getTutorialVideoUrl()).toBeNull();
  });

  // 空白だけの設定値も未設定扱い
  it('空白だけの設定値は null を返す', () => {
    vi.stubEnv('TUTORIAL_VIDEO_URL', '   ');
    expect(getTutorialVideoUrl()).toBeNull();
  });

  // 正しい https URL はそのまま返す
  it('正しい https URL をそのまま返す', () => {
    vi.stubEnv('TUTORIAL_VIDEO_URL', 'https://example.com/videos/getting-started.mp4');
    expect(getTutorialVideoUrl()).toBe('https://example.com/videos/getting-started.mp4');
  });

  // URL として解釈できない値は null (壊れたリンクを出さない)
  it('壊れた URL は null を返す', () => {
    vi.stubEnv('TUTORIAL_VIDEO_URL', 'not a url');
    expect(getTutorialVideoUrl()).toBeNull();
  });

  // http(s) 以外の scheme (javascript: 等) は null (§9 出力のサニタイズ)
  it('javascript: scheme は null を返す', () => {
    vi.stubEnv('TUTORIAL_VIDEO_URL', 'javascript:alert(1)');
    expect(getTutorialVideoUrl()).toBeNull();
  });
});
