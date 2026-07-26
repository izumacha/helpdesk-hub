// 認証イベント監査の書き込み入口 (src/lib/auth-audit.ts) の単体テスト。
// email の切り詰め・失敗イベントの書き込み上限・fail-open (記録失敗を認証へ伝播させない) を検証する。

import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock のファクトリはファイル先頭へ巻き上げられるため、参照する mock 関数は
// vi.hoisted で同様に巻き上げて「初期化前参照」エラーを避ける
const { recordMock } = vi.hoisted(() => ({ recordMock: vi.fn() }));

// データ層をモック: recordAuthAudit が使うのは repos.authAudit.record のみ
vi.mock('@/data', () => ({
  repos: { authAudit: { record: recordMock } },
}));

// テスト対象 (モック設定後に import する)
import {
  AUTH_AUDIT_EMAIL_MAX_LENGTH,
  AUTH_AUDIT_FAILURE_MAX_PER_WINDOW,
  recordAuthAudit,
  __resetAuthAuditThrottle,
} from '@/lib/auth-audit';

describe('recordAuthAudit', () => {
  beforeEach(() => {
    // 書き込み上限の内部状態とモック履歴をテストごとにリセットする
    __resetAuthAuditThrottle();
    recordMock.mockReset();
  });

  // 通常の入力はそのまま record へ渡ること
  it('passes a normal event through to the repository', async () => {
    // ログイン成功イベントを記録する
    await recordAuthAudit({
      event: 'password_login_success',
      email: 'agent@example.com',
      userId: 'u1',
      tenantId: 't1',
    });
    // repos.authAudit.record が同じ内容で呼ばれている
    expect(recordMock).toHaveBeenCalledWith({
      event: 'password_login_success',
      email: 'agent@example.com',
      userId: 'u1',
      tenantId: 't1',
    });
  });

  // 攻撃者制御の超長 email は上限で切り詰めてから記録すること
  // (B-tree インデックスの行サイズ上限超過による INSERT 失敗 = 確定 500 の防止)
  it('truncates an oversized email before recording', async () => {
    // 上限を大きく超える長さの email を作る
    const hugeEmail = `${'a'.repeat(5000)}@example.com`;
    // 失敗イベントとして記録する
    await recordAuthAudit({
      event: 'password_login_failure',
      email: hugeEmail,
      userId: null,
      tenantId: null,
    });
    // 記録された email が上限長に切り詰められている
    const recorded = recordMock.mock.calls[0][0] as { email: string };
    expect(recorded.email).toHaveLength(AUTH_AUDIT_EMAIL_MAX_LENGTH);
    expect(recorded.email).toBe(hugeEmail.slice(0, AUTH_AUDIT_EMAIL_MAX_LENGTH));
  });

  // 失敗イベントは 1 窓あたりの上限件数を超えたら DB へ書かないこと (ストレージ枯渇 DoS の防止)
  it('caps failure-event writes per window', async () => {
    // 上限 +10 件の失敗イベントを連続で記録する
    for (let i = 0; i < AUTH_AUDIT_FAILURE_MAX_PER_WINDOW + 10; i += 1) {
      await recordAuthAudit({
        event: 'password_login_failure',
        email: `spray${i}@example.com`,
        userId: null,
        tenantId: null,
      });
    }
    // DB への書き込みは上限件数で頭打ちになっている
    expect(recordMock).toHaveBeenCalledTimes(AUTH_AUDIT_FAILURE_MAX_PER_WINDOW);
  });

  // 成功イベントは失敗上限の対象外であること (正規ログインの監査を落とさない)
  it('does not cap success events', async () => {
    // 失敗の予算を使い切る
    for (let i = 0; i < AUTH_AUDIT_FAILURE_MAX_PER_WINDOW; i += 1) {
      await recordAuthAudit({
        event: 'password_login_failure',
        email: `spray${i}@example.com`,
        userId: null,
        tenantId: null,
      });
    }
    recordMock.mockClear();
    // 成功イベントは予算枯渇後でも記録される
    await recordAuthAudit({
      event: 'password_login_success',
      email: 'agent@example.com',
      userId: 'u1',
      tenantId: 't1',
    });
    expect(recordMock).toHaveBeenCalledTimes(1);
  });

  // fail-open: record が throw しても呼び出し元へ伝播しないこと
  // (マジックリンクはトークン消費後に記録するため、throw するとトークンが焼失したまま
  //  ログインが失敗してしまう。auth-audit.ts のモジュールコメント参照)
  it('swallows repository errors instead of propagating them', async () => {
    // 記録が DB エラーで失敗する状況を作る
    recordMock.mockRejectedValueOnce(new Error('db down'));
    // console.error が呼ばれることだけ確認し、出力自体は抑制する
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // throw せずに完了することを検証する
    await expect(
      recordAuthAudit({
        event: 'magic_link_login_success',
        email: 'agent@example.com',
        userId: 'u1',
        tenantId: 't1',
      }),
    ).resolves.toBeUndefined();
    // 失敗は文脈付きでログに残っている (§6 エラーを握り潰さない)
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
