// Vitest の DSL とモック機能
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock のファクトリはファイル先頭へ巻き上げられるため、参照する mock 関数は
// vi.hoisted で同様に巻き上げて「初期化前参照」エラーを避ける。
const { findByEmail, recordAuthAudit } = vi.hoisted(() => ({
  findByEmail: vi.fn(),
  recordAuthAudit: vi.fn(),
}));

// データ層をモック: passwordAuthorize が使うのは repos.users.findByEmail と
// repos.authAudit.record (認証イベント監査 / 否認防止) のみ
vi.mock('@/data', () => ({
  repos: { users: { findByEmail }, authAudit: { record: recordAuthAudit } },
}));

// bcryptjs をモック: compare は「正しいパスワード」のときだけ true を返す。
// hashSync はダミーハッシュ生成用に固定文字列を返す (実際の計算はしない)。
vi.mock('bcryptjs', () => ({
  compare: vi.fn(async (pw: string) => pw === 'correct-password'),
  hashSync: vi.fn(() => '$2a$12$dummy.decoy.hash.value.placeholder.0123456789abc'),
}));

// テスト対象 (モック設定後に import する)
import { passwordAuthorize } from '@/lib/password-authorize';
// 失敗カウントをテスト間でリセットするためのヘルパー
import { __resetLoginThrottle } from '@/lib/login-throttle';
// 監査ログの失敗イベント書き込み上限をテスト間でリセットするためのヘルパー
import { __resetAuthAuditThrottle } from '@/lib/auth-audit';
// 呼び出し回数を検証するためモック化済みの compare を取得
import { compare } from 'bcryptjs';

// テストで使う既存ユーザー (passwordHash 付き)
const USER = {
  id: 'u1',
  email: 'user@example.com',
  name: 'User One',
  role: 'agent' as const,
  tenantId: 't1',
  passwordHash: '$2a$12$realhashplaceholderplaceholderplaceholderplace',
  createdAt: new Date(),
  updatedAt: new Date(),
};

// passwordAuthorize (ログイン認証本体 + スロットル配線) の振る舞いを検証する
describe('passwordAuthorize (#119)', () => {
  // 各テストの前に失敗カウントとモックの呼び出し履歴を初期化する
  beforeEach(() => {
    // スロットルの内部状態をクリア (テスト間の独立性を保つ)
    __resetLoginThrottle();
    // 監査ログの失敗イベント書き込み上限もクリアする (テスト間の独立性を保つ)
    __resetAuthAuditThrottle();
    // findByEmail の実装と履歴を消す (各テストで個別に mockResolvedValue する)
    findByEmail.mockReset();
    // 認証イベント監査の記録モックも履歴を消す (各テストで呼び出し内容を検証する)
    recordAuthAudit.mockReset();
    // compare は実装を保持したまま呼び出し履歴だけクリアする
    vi.mocked(compare).mockClear();
  });

  // 正しいパスワードなら user を返し、失敗カウントをクリアする
  it('returns the user object on a correct password', async () => {
    // ユーザーが見つかる状態にする
    findByEmail.mockResolvedValue(USER);
    // 正しいパスワードで認証する
    const res = await passwordAuthorize(
      { email: 'user@example.com', password: 'correct-password' },
      undefined,
    );
    // role / tenantId 込みのユーザー情報が返ること
    expect(res).toMatchObject({ id: 'u1', role: 'agent', tenantId: 't1' });
  });

  // 入力欠如 (email/password 無し) は即 null
  it('returns null when email or password is missing', async () => {
    // password が無いケース
    const res = await passwordAuthorize({ email: 'user@example.com' }, undefined);
    // 認証は失敗し、DB も引かない
    expect(res).toBeNull();
    expect(findByEmail).not.toHaveBeenCalled();
  });

  // 誤ったパスワードは null を返す
  it('returns null on a wrong password', async () => {
    // ユーザーは存在する
    findByEmail.mockResolvedValue(USER);
    // 誤ったパスワードで認証する
    const res = await passwordAuthorize(
      { email: 'user@example.com', password: 'wrong' },
      undefined,
    );
    // 認証失敗
    expect(res).toBeNull();
  });

  // ユーザー不在経路でもダミー bcrypt compare を実行する (在不在のタイミングオラクル緩和)
  it('runs a dummy bcrypt compare when the user does not exist', async () => {
    // ユーザーが見つからない状態にする
    findByEmail.mockResolvedValue(null);
    // 存在しないメールで認証する
    const res = await passwordAuthorize(
      { email: 'ghost@example.com', password: 'whatever' },
      undefined,
    );
    // 認証は失敗する
    expect(res).toBeNull();
    // それでも compare は 1 回呼ばれている (ダミーハッシュとの比較で処理時間を揃える)
    expect(vi.mocked(compare)).toHaveBeenCalledTimes(1);
  });

  // 5 回失敗するとロックアウトし、6 回目は DB を引く前に短絡する
  it('locks out after 5 failures and short-circuits before the DB lookup', async () => {
    // ユーザーは存在する (= 失敗はパスワード不一致による)
    findByEmail.mockResolvedValue(USER);
    // 5 回連続で誤ったパスワードを送る
    for (let i = 0; i < 5; i += 1) {
      await passwordAuthorize({ email: 'user@example.com', password: 'wrong' }, undefined);
    }
    // ここまでで findByEmail は 5 回呼ばれている
    const callsAfterFive = findByEmail.mock.calls.length;
    // 6 回目は「正しいパスワード」でもロックアウト中なので拒否される
    const res = await passwordAuthorize(
      { email: 'user@example.com', password: 'correct-password' },
      undefined,
    );
    // 認証は拒否される
    expect(res).toBeNull();
    // かつ DB lookup は増えていない (bcrypt 前に短絡したことの証明)
    expect(findByEmail.mock.calls.length).toBe(callsAfterFive);
  });

  // ログイン成功は失敗カウントをリセットする
  it('resets the failure counter after a successful login', async () => {
    // ユーザーは存在する
    findByEmail.mockResolvedValue(USER);
    // 上限未満の 4 回失敗させる
    for (let i = 0; i < 4; i += 1) {
      await passwordAuthorize({ email: 'user@example.com', password: 'wrong' }, undefined);
    }
    // 正しいパスワードで成功させる (この時点で失敗カウントがクリアされる)
    expect(
      await passwordAuthorize(
        { email: 'user@example.com', password: 'correct-password' },
        undefined,
      ),
    ).not.toBeNull();
    // リセット後、再び 4 回失敗させる (まだロックされないはず)
    for (let i = 0; i < 4; i += 1) {
      await passwordAuthorize({ email: 'user@example.com', password: 'wrong' }, undefined);
    }
    // 5 回目の失敗の直前の呼び出し回数を控える
    const before = findByEmail.mock.calls.length;
    // 5 回目の失敗はまだロックされておらず DB に到達する (= リセットが効いている証明)
    await passwordAuthorize({ email: 'user@example.com', password: 'wrong' }, undefined);
    // findByEmail が 1 回増えている (短絡していない)
    expect(findByEmail.mock.calls.length).toBe(before + 1);
  });

  // ロックアウトはメール単位で、大文字小文字を区別しない
  it('keys lockout by email case-insensitively', async () => {
    // ユーザーは存在する
    findByEmail.mockResolvedValue(USER);
    // 大文字混じりのメールで 5 回失敗させる
    for (let i = 0; i < 5; i += 1) {
      await passwordAuthorize({ email: 'User@Example.com', password: 'wrong' }, undefined);
    }
    // ここまでの DB 呼び出し回数を控える
    const calls = findByEmail.mock.calls.length;
    // 小文字の同一メールは同じバケット → ロック中で DB を引かない
    await passwordAuthorize(
      { email: 'user@example.com', password: 'correct-password' },
      undefined,
    );
    // DB 呼び出しは増えていない (同一メール扱いでロックされている)
    expect(findByEmail.mock.calls.length).toBe(calls);
  });

  // IP 単位でもロックアウトする (X-Forwarded-For ヘッダ由来)
  it('also locks out by client IP from x-forwarded-for', async () => {
    // ユーザーは存在する
    findByEmail.mockResolvedValue(USER);
    // 同一 IP・異なるメールで 5 回失敗させる (メールキーは分散、IP キーが累積)
    for (let i = 0; i < 5; i += 1) {
      // 攻撃者が毎回違うメールを試すが送信元 IP は同じという想定
      const req = new Request('http://localhost/api/auth', {
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      await passwordAuthorize({ email: `spray${i}@example.com`, password: 'wrong' }, req);
    }
    // 同一 IP からの 6 回目は IP ロックで短絡する
    const calls = findByEmail.mock.calls.length;
    const req = new Request('http://localhost/api/auth', {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    // 別メールでも同一 IP なのでロックされ、DB を引かない
    await passwordAuthorize({ email: 'spray-final@example.com', password: 'wrong' }, req);
    // DB 呼び出しが増えていない (IP キーで短絡)
    expect(findByEmail.mock.calls.length).toBe(calls);
  });

  // 認証イベント監査 (否認防止): ログイン成功は password_login_success として記録される
  it('records password_login_success with the user identity on success', async () => {
    // ユーザーは存在する
    findByEmail.mockResolvedValue(USER);
    // 正しいパスワードで認証する
    await passwordAuthorize(
      { email: 'user@example.com', password: 'correct-password' },
      undefined,
    );
    // 成功イベントが対象ユーザーの識別子付きで記録されている
    expect(recordAuthAudit).toHaveBeenCalledWith({
      event: 'password_login_success',
      email: 'user@example.com',
      userId: 'u1',
      tenantId: 't1',
    });
  });

  // 認証イベント監査: パスワード不一致の失敗は対象ユーザー付きで記録される
  it('records password_login_failure with the user identity on a wrong password', async () => {
    // ユーザーは存在する
    findByEmail.mockResolvedValue(USER);
    // 誤ったパスワードで認証する
    await passwordAuthorize({ email: 'user@example.com', password: 'wrong' }, undefined);
    // 失敗イベントが対象ユーザーの識別子付きで記録されている
    expect(recordAuthAudit).toHaveBeenCalledWith({
      event: 'password_login_failure',
      email: 'user@example.com',
      userId: 'u1',
      tenantId: 't1',
    });
  });

  // 認証イベント監査: 不在メールへの失敗も userId/tenantId = null で記録される
  it('records password_login_failure with null identity for an unknown email', async () => {
    // ユーザーが見つからない状態にする
    findByEmail.mockResolvedValue(null);
    // 大文字混じりの不在メールで認証を試みる
    await passwordAuthorize({ email: 'Ghost@Example.com', password: 'whatever' }, undefined);
    // メールは小文字正規化された値で、識別子は null のまま記録されている
    expect(recordAuthAudit).toHaveBeenCalledWith({
      event: 'password_login_failure',
      email: 'ghost@example.com',
      userId: null,
      tenantId: null,
    });
  });

  // 認証イベント監査: ロックアウト中の短絡拒否は記録しない (DB 書き込み増幅の防止。実装コメント参照)
  it('does not record an audit event while locked out', async () => {
    // ユーザーは存在する
    findByEmail.mockResolvedValue(USER);
    // 5 回失敗してロックアウトさせる (この 5 回はそれぞれ failure が記録される)
    for (let i = 0; i < 5; i += 1) {
      await passwordAuthorize({ email: 'user@example.com', password: 'wrong' }, undefined);
    }
    // ここまでの監査記録の呼び出し回数を控える
    const callsAfterFive = recordAuthAudit.mock.calls.length;
    // ロックアウト中の 6 回目は短絡拒否され、監査行も増えない
    await passwordAuthorize(
      { email: 'user@example.com', password: 'correct-password' },
      undefined,
    );
    // 監査記録の回数が変わっていない (短絡経路では書かない設計の証明)
    expect(recordAuthAudit.mock.calls.length).toBe(callsAfterFive);
  });
});
