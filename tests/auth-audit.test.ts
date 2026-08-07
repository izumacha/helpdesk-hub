// 認証イベント監査の書き込み入口 (src/lib/auth-audit.ts) の単体テスト。
// email の切り詰め・失敗イベントの書き込み上限・fail-open (記録失敗を認証へ伝播させない) を検証する。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  AUTH_AUDIT_EVENT_IS_FAILURE,
  AUTH_AUDIT_FAILURE_MAX_PER_EVENT_WINDOW,
  AUTH_AUDIT_FAILURE_MAX_PER_WINDOW,
  AUTH_AUDIT_UNKNOWN_EMAIL,
  recordAuthAudit,
  __resetAuthAuditThrottle,
} from '@/lib/auth-audit';
// イベント種別の型 (分類表のキーを型付きで扱うために使う)
import type { AuthAuditEvent } from '@/domain/types';

// 分類表から失敗イベント / 成功イベントの一覧を導出する。
// 表を直接引くことで、イベントを追加したら自動的に下の it.each の対象にもなる
// (表への追加自体は Record の網羅性チェックにより typecheck で強制される)
const eventsWhere = (isFailure: boolean): AuthAuditEvent[] =>
  (Object.keys(AUTH_AUDIT_EVENT_IS_FAILURE) as AuthAuditEvent[]).filter(
    (event) => AUTH_AUDIT_EVENT_IS_FAILURE[event] === isFailure,
  );
// 書き込み上限の対象になる失敗イベント
const FAILURE_EVENTS = eventsWhere(true);
// 上限の対象外であるべき成功イベント
const SUCCESS_EVENTS = eventsWhere(false);

describe('recordAuthAudit', () => {
  beforeEach(() => {
    // 書き込み上限の内部状態とモック履歴をテストごとにリセットする
    __resetAuthAuditThrottle();
    recordMock.mockReset();
    // 上限超過時の警告はテスト出力を埋めるだけなので抑制する (呼ばれること自体は検証しない)
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    // spy を元に戻し、他のテストファイルへ影響を残さない
    vi.restoreAllMocks();
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

  // 分類表そのものが正しいこと。上の一覧は表から導出しているため、この表明が無いと
  // 「失敗イベントを誤って false に分類した」ミスを検出できない (導出テストは素通りする)。
  // 意図を独立に書き下すことで、分類の取り違えをここで止める
  it('classifies exactly the failure events as failures', () => {
    expect([...FAILURE_EVENTS].sort()).toEqual(
      [
        'magic_link_login_failure',
        'password_login_failure',
        'sso_assertion_rejected',
        'sso_assertion_replayed',
        'sso_user_not_found',
      ].sort(),
    );
  });

  // 失敗イベントは 1 窓あたりの上限件数を超えたら DB へ書かないこと (ストレージ枯渇 DoS の防止)。
  // パスワード経路に限らず全種別が上限の対象であること。
  // マジックリンク・SAML の失敗は未認証の攻撃者がリクエストを繰り返すだけで発火するため、
  // 1 種別でも上限から漏れると追記専用テーブルに行を無制限に積める抜け穴になる
  it.each(FAILURE_EVENTS)('caps %s writes per window', async (event) => {
    // 上限 +5 件の失敗イベントを連続で記録する
    for (let i = 0; i < AUTH_AUDIT_FAILURE_MAX_PER_EVENT_WINDOW + 5; i += 1) {
      await recordAuthAudit({
        event,
        email: `spray${i}@example.com`,
        userId: null,
        tenantId: null,
      });
    }
    // DB への書き込みは上限件数で頭打ちになっている
    expect(recordMock).toHaveBeenCalledTimes(AUTH_AUDIT_FAILURE_MAX_PER_EVENT_WINDOW);
  });

  // 予算はイベント種別ごとに独立していること (監査の目潰し攻撃の防止)。
  // マジックリンクのコールバックや SSO ACS は未認証で安く叩けるため、予算を全経路で共有すると
  // そこへゴミを投げるだけでパスワード総当たりの失敗記録を DB から締め出せてしまう。
  // それでは「console.warn では否認防止の証跡にならない」という本機能の前提が崩れる
  it.each(FAILURE_EVENTS.filter((event) => event !== 'password_login_failure'))(
    'does not let %s starve the password failure budget',
    async (noisyEvent) => {
      // 未認証で叩ける経路の失敗だけで、その種別の予算を使い切る
      for (let i = 0; i < AUTH_AUDIT_FAILURE_MAX_PER_EVENT_WINDOW + 5; i += 1) {
        await recordAuthAudit({
          event: noisyEvent,
          email: AUTH_AUDIT_UNKNOWN_EMAIL,
          userId: null,
          tenantId: 't1',
        });
      }
      recordMock.mockClear();
      // 同じ窓の中でも、パスワード経路の失敗は自分の予算で記録され続ける
      await recordAuthAudit({
        event: 'password_login_failure',
        email: 'victim@example.com',
        userId: null,
        tenantId: null,
      });
      expect(recordMock).toHaveBeenCalledTimes(1);
    },
  );

  // 種別ごとに分けても、全種別を合計した 1 窓あたりの書き込み量は従来の上限を超えないこと。
  // 分割で「経路数だけ上限が積み上がる」とストレージ枯渇の許容量が勝手に増えてしまう
  it('keeps the aggregate write budget within the total cap', () => {
    expect(AUTH_AUDIT_FAILURE_MAX_PER_EVENT_WINDOW * FAILURE_EVENTS.length).toBeLessThanOrEqual(
      AUTH_AUDIT_FAILURE_MAX_PER_WINDOW,
    );
    // 分割が機能する程度の予算が各種別に残っていること (0 件だと失敗記録が一切残らない)
    expect(AUTH_AUDIT_FAILURE_MAX_PER_EVENT_WINDOW).toBeGreaterThan(0);
  });

  // 成功イベントは失敗上限の対象外であること (攻撃中でも正規ログインの監査を落とさない)
  it.each(SUCCESS_EVENTS)('does not cap %s', async (event) => {
    // 全種別の失敗の予算を使い切る (成功イベントがどの失敗経路の枯渇にも影響されないことを見る)
    for (const failureEvent of FAILURE_EVENTS) {
      for (let i = 0; i < AUTH_AUDIT_FAILURE_MAX_PER_EVENT_WINDOW; i += 1) {
        await recordAuthAudit({
          event: failureEvent,
          email: `spray${i}@example.com`,
          userId: null,
          tenantId: null,
        });
      }
    }
    recordMock.mockClear();
    // 成功イベントは予算枯渇後でも記録される
    await recordAuthAudit({ event, email: 'agent@example.com', userId: 'u1', tenantId: 't1' });
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
