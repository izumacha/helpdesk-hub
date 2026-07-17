// Vitest のテスト DSL とモック機能
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ実装の context (store/repos)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// リポジトリ束の型
import type { Repos } from '@/data/ports/unit-of-work';
// EmailSender 型 (fake 実装で利用)
import type { EmailSender } from '@/lib/email';
// マジックリンク URL 構築 (fake send 内で URL に含まれるトークンを取り出すために使う)
import { hashMagicLinkToken } from '@/lib/magic-link';
// レート制限バケットをテスト間で初期化するヘルパー (監査で発見したギャップ対応で追加した
// エンドポイント全体のレート制限を、このファイルのテスト間で持ち越さないようにする)
import { __resetRateLimits } from '@/lib/rate-limit';

// 各テスト前に書き換える依存。Action import 前に getter で参照させる
let store: Store;
let repos: Repos;
// EmailSender への呼び出しを記録するフェイク
let sentMessages: { to: string; subject: string; html: string; text: string }[] = [];

// @/data を差し替え。getter で参照することで、テスト中の上書きが反映される
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

// EmailSender ファクトリを差し替え。send は既定で sentMessages に記録するだけだが、
// テストから throw に差し替えたいケースのために stub にしておく
let sendImpl: (message: {
  to: string;
  subject: string;
  html: string;
  text: string;
}) => Promise<void> = async (message) => {
  sentMessages.push(message);
};
// ファクトリ自体が throw する設定エラーをシミュレートできるよう、フラグ経由で挙動を切替
let getEmailSenderImpl: () => EmailSender = () => ({
  async send(message) {
    await sendImpl(message);
  },
});
vi.mock('@/lib/email', () => ({
  getEmailSender: () => getEmailSenderImpl(),
}));

// 動的 import: 上のモック設定が反映された後で対象を読み込む
async function loadAction() {
  const mod = await import('@/features/auth/actions/request-magic-link');
  return mod.requestMagicLink;
}

// テストごとにクリーンな状態にする
beforeEach(() => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  sentMessages = [];
  // 既定の sendImpl を「記録するだけ」に戻す (個別テストで上書きすることがある)
  sendImpl = async (message) => {
    sentMessages.push(message);
  };
  // ファクトリも既定の「正常な EmailSender を返す」実装に戻す
  getEmailSenderImpl = () => ({
    async send(message) {
      await sendImpl(message);
    },
  });
  // テナントを 1 つ用意 (User の FK 先として必要)
  store.tenants.set('default-tenant', {
    id: 'default-tenant',
    name: 'デフォルト組織',
    mode: 'lite',
    industry: null,
    inboundToken: null, // メール取り込み未発行 (テスト用フィクスチャ)
    slackWebhookUrl: null,
    subscriptionPlan: 'free' as const,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    trialEndsAt: null,
    teamsWebhookUrl: null,
    chatworkApiToken: null,
    chatworkRoomId: null, // Slack 通知未設定 (テスト用フィクスチャ)
    createdAt: new Date(),
  });
  // レート制限バケットをクリアする (前のテストの呼び出し回数を持ち越さない)
  __resetRateLimits();
});

// 各テスト後に環境変数スタブを必ず巻き戻す
afterEach(() => {
  vi.unstubAllEnvs();
  __resetRateLimits();
});

describe('requestMagicLink', () => {
  // 既知ユーザーへ送信されること + DB にはハッシュのみが保存されること
  it('既知ユーザー宛にメールが送信され、ハッシュのみが DB に保存される', async () => {
    // ユーザーを seed
    store.users.set('u-1', {
      id: 'u-1',
      email: 'requester1@example.com',
      name: '依頼者1',
      passwordHash: 'x',
      role: 'requester',
      tenantId: 'default-tenant',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Action 呼び出し
    const requestMagicLink = await loadAction();
    const result = await requestMagicLink({ email: 'requester1@example.com' });

    // 戻り値は常に ok
    expect(result).toEqual({ ok: true });
    // メールが 1 件送信されている
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].to).toBe('requester1@example.com');
    // URL がメール本文に含まれる
    const match = sentMessages[0].text.match(/https?:\/\/\S+token=([A-Za-z0-9_-]+)/);
    expect(match).not.toBeNull();
    const rawTokenFromEmail = match![1];

    // DB にはハッシュが 1 件保存されている (生トークンは保存されていない)
    expect(store.magicLinks.size).toBe(1);
    const stored = [...store.magicLinks.values()][0];
    expect(stored.tokenHash).toBe(await hashMagicLinkToken(rawTokenFromEmail));
    expect(stored.tokenHash).not.toBe(rawTokenFromEmail);
    expect(stored.consumedAt).toBeNull();
    // 失効時刻は今より未来 (約 15 分後) であること
    expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  // 未登録メールでもエラーは投げず、メールも送らないこと (列挙対策)
  it('未登録メールに対しても ok を返し、メールは送らない', async () => {
    const requestMagicLink = await loadAction();
    const result = await requestMagicLink({ email: 'unknown@example.com' });
    // 戻り値は常に ok
    expect(result).toEqual({ ok: true });
    // メールは送られていない
    expect(sentMessages).toHaveLength(0);
    // DB にも何も保存されていない
    expect(store.magicLinks.size).toBe(0);
  });

  // メールアドレスが大文字小文字混在でも DB は小文字で保存されること
  it('入力メールを小文字に正規化して扱う', async () => {
    // 小文字で seed
    store.users.set('u-1', {
      id: 'u-1',
      email: 'mixed@example.com',
      name: 'm',
      passwordHash: 'x',
      role: 'requester',
      tenantId: 'default-tenant',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const requestMagicLink = await loadAction();
    // 大文字混じりで呼び出し
    await requestMagicLink({ email: 'Mixed@Example.COM' });

    // 1 件発行され、email は小文字化されている
    expect(store.magicLinks.size).toBe(1);
    expect([...store.magicLinks.values()][0].email).toBe('mixed@example.com');
  });

  // 不正なメール形式は例外で弾かれること
  it('メール形式が不正なら例外を投げる', async () => {
    const requestMagicLink = await loadAction();
    await expect(requestMagicLink({ email: 'not-an-email' })).rejects.toThrow(/メールアドレス/);
  });

  // 本番で NEXTAUTH_URL が未設定なら、リンクが壊れるのを防ぐため起動時エラーにする
  // (列挙対策の握り潰しの外で評価されるので、運用者にきちんと 500 が見える)
  it('production で NEXTAUTH_URL 未設定なら例外を投げる (リンク先 localhost フォールバック禁止)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXTAUTH_URL', '');
    const requestMagicLink = await loadAction();
    await expect(requestMagicLink({ email: 'agent1@example.com' })).rejects.toThrow(/NEXTAUTH_URL/);
  });

  // 空白だけの NEXTAUTH_URL は未指定と同じく扱う (production ならエラー)
  it('production で NEXTAUTH_URL が空白だけの値は未指定と同じくエラー', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXTAUTH_URL', '   ');
    const requestMagicLink = await loadAction();
    await expect(requestMagicLink({ email: 'agent1@example.com' })).rejects.toThrow(/NEXTAUTH_URL/);
  });

  // NEXTAUTH_URL が壊れた形式 (scheme なし / 不正な URL) なら明示エラー
  it.each([
    'not-a-url',
    'example.com', // scheme 欠落
    'http://', // host 欠落
    'file:///etc/passwd', // 危険な scheme
  ])('NEXTAUTH_URL=%s のような不正形式は例外を投げる', async (badUrl) => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('NEXTAUTH_URL', badUrl);
    const requestMagicLink = await loadAction();
    await expect(requestMagicLink({ email: 'agent1@example.com' })).rejects.toThrow(/NEXTAUTH_URL/);
  });

  // 設定不備 (EMAIL_DRIVER 不正など) は列挙対策のマスクを越えて呼び出し側まで伝わる。
  // 「届かないメール」を silently 増やすより、運用者に 500 で見せる方を優先する
  it('EmailSender ファクトリが throw する設定エラーは握り潰さず呼び出し側へ伝える', async () => {
    // ユーザー seed (登録済み経路でも非登録経路でも結果は同じはず)
    store.users.set('u-1', {
      id: 'u-1',
      email: 'a@example.com',
      name: 'a',
      passwordHash: 'x',
      role: 'requester',
      tenantId: 'default-tenant',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // ファクトリが設定エラーで throw する状況をシミュレート
    getEmailSenderImpl = () => {
      throw new Error('production では EMAIL_DRIVER=smtp の明示設定が必要です');
    };
    const requestMagicLink = await loadAction();
    await expect(requestMagicLink({ email: 'a@example.com' })).rejects.toThrow(/EMAIL_DRIVER/);
    // 設定エラーは未登録メールでも同様に表面化する (列挙耐性が壊れないこと)
    await expect(requestMagicLink({ email: 'unknown@example.com' })).rejects.toThrow(
      /EMAIL_DRIVER/,
    );
  });

  // メール送信が失敗しても呼び出し側には {ok: true} を返すこと (列挙耐性)
  it('メール送信が失敗しても呼び出し側からは {ok: true} に見える (列挙耐性)', async () => {
    // ユーザー seed
    store.users.set('u-1', {
      id: 'u-1',
      email: 'fail@example.com',
      name: 'f',
      passwordHash: 'x',
      role: 'requester',
      tenantId: 'default-tenant',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // send を失敗するように差し替え
    sendImpl = async () => {
      throw new Error('simulated SMTP outage');
    };
    const requestMagicLink = await loadAction();
    const result = await requestMagicLink({ email: 'fail@example.com' });
    // 呼び出し側からは成功と区別できない
    expect(result).toEqual({ ok: true });
  });

  // メール送信失敗時にはトークン行が削除されること (rate-limit を消費しない)
  it('メール送信失敗時にトークン行が削除される (rate-limit 枠を消費しない)', async () => {
    // ユーザー seed
    store.users.set('u-2', {
      id: 'u-2',
      email: 'flaky@example.com',
      name: 'fl',
      passwordHash: 'x',
      role: 'requester',
      tenantId: 'default-tenant',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // 1 回目は失敗、2 回目は成功するように切替
    let attempt = 0;
    sendImpl = async (message) => {
      attempt += 1;
      if (attempt === 1) throw new Error('first attempt fails');
      sentMessages.push(message);
    };
    const requestMagicLink = await loadAction();
    // 1 回目: 失敗するが {ok:true} を返し、行は削除されているはず
    await requestMagicLink({ email: 'flaky@example.com' });
    expect(store.magicLinks.size).toBe(0); // rollback された
    // 2 回目: 成功して 1 件残る
    await requestMagicLink({ email: 'flaky@example.com' });
    expect(store.magicLinks.size).toBe(1);
    expect(sentMessages).toHaveLength(1);
  });

  // 同一メール宛に短時間で大量に要求しても、上限を超えたらメール送信されないこと (発行スパム対策)
  it('レート制限: 同一メール宛 15 分以内 5 通を超えると新規発行されない', async () => {
    // ユーザー seed
    store.users.set('u-rate', {
      id: 'u-rate',
      email: 'rate@example.com',
      name: 'r',
      passwordHash: 'x',
      role: 'requester',
      tenantId: 'default-tenant',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const requestMagicLink = await loadAction();
    // 上限 (5 件) ぴったりまでは発行が許される
    for (let i = 0; i < 5; i++) {
      await requestMagicLink({ email: 'rate@example.com' });
    }
    // 5 件の token と 5 通のメール送信があること
    expect(store.magicLinks.size).toBe(5);
    expect(sentMessages).toHaveLength(5);

    // 6 件目はレート制限で発行されない (戻り値は ok のまま、副作用なし)
    const result = await requestMagicLink({ email: 'rate@example.com' });
    expect(result).toEqual({ ok: true });
    // 件数は増えていないこと
    expect(store.magicLinks.size).toBe(5);
    expect(sentMessages).toHaveLength(5);
  });

  // 期限切れトークンが掃除されること
  it('呼び出し時に失効済みトークンを掃除する', async () => {
    // ユーザー seed
    store.users.set('u-1', {
      id: 'u-1',
      email: 'a@example.com',
      name: 'a',
      passwordHash: 'x',
      role: 'requester',
      tenantId: 'default-tenant',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // 失効済みトークンを 1 件、有効を 1 件、ストア直接投入
    const now = Date.now();
    store.magicLinks.set('mlt-old', {
      id: 'mlt-old',
      email: 'a@example.com',
      tokenHash: 'old-hash',
      expiresAt: new Date(now - 60_000),
      consumedAt: null,
      requestedIp: null,
      createdAt: new Date(now - 30 * 60_000),
    });
    store.magicLinks.set('mlt-ok', {
      id: 'mlt-ok',
      email: 'a@example.com',
      tokenHash: 'ok-hash',
      expiresAt: new Date(now + 5 * 60_000),
      consumedAt: null,
      requestedIp: null,
      createdAt: new Date(now - 1 * 60_000),
    });
    // Action 呼び出し (これで掃除 + 新規発行が起きる)
    const requestMagicLink = await loadAction();
    await requestMagicLink({ email: 'a@example.com' });

    // 失効済みは消えている、有効分は残る、新規発行 1 件で計 2 件
    expect(store.magicLinks.has('mlt-old')).toBe(false);
    expect(store.magicLinks.has('mlt-ok')).toBe(true);
    expect(store.magicLinks.size).toBe(2);
  });

  // 監査で発見したギャップ対応: 異なるメールアドレスを使ってもエンドポイント全体の固定キー
  // レート制限で頭打ちになること (request-signup.ts の同種テストと同じ方式)
  it('レート制限: 異なるメールアドレスを使ってもエンドポイント全体の上限 (1分30件) で頭打ちになる', async () => {
    const requestMagicLink = await loadAction();
    // 上限 (30 件) ぴったりまでは、未登録メールでも (列挙対策で送信自体はされないが) 発行が許される
    for (let i = 0; i < 30; i++) {
      await requestMagicLink({ email: `flood-${i}@example.com` });
    }
    // 31 件目は別のメールアドレスでも、全体レート制限に引っかかり例外を投げる
    await expect(requestMagicLink({ email: 'flood-overflow@example.com' })).rejects.toThrow(
      /頻度が高すぎます/,
    );
  });

  // 監査で発見したギャップ対応: 再送すると古いリンクは無効化され、新しいリンクだけが使えること
  it('マジックリンクを再送すると、古いリンクは無効化され新しいリンクだけが使える', async () => {
    // ユーザー seed
    store.users.set('u-reissue', {
      id: 'u-reissue',
      email: 'reissue@example.com',
      name: 'r',
      passwordHash: 'x',
      role: 'requester',
      tenantId: 'default-tenant',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const requestMagicLink = await loadAction();

    // 1 回目のリクエストでトークンを発行する
    await requestMagicLink({ email: 'reissue@example.com' });
    expect(sentMessages).toHaveLength(1);
    const firstMatch = sentMessages[0].text.match(/https?:\/\/\S+token=([A-Za-z0-9_-]+)/);
    const firstRawToken = firstMatch![1];

    // 2 回目のリクエスト (再送) で新しいトークンを発行する
    await requestMagicLink({ email: 'reissue@example.com' });
    expect(sentMessages).toHaveLength(2);

    // 古いトークンは行としては残るが、消費済み (使用不可) 扱いになっている
    const firstTokenHash = await hashMagicLinkToken(firstRawToken);
    const firstRow = [...store.magicLinks.values()].find((t) => t.tokenHash === firstTokenHash);
    expect(firstRow).toBeDefined();
    expect(firstRow!.consumedAt).not.toBeNull();

    // consumeValidToken (実際のログインコールバックが使う原子的消費) も古いトークンを拒否する
    const consumed = await repos.magicLinks.consumeValidToken({
      tokenHash: firstTokenHash,
      now: new Date(),
    });
    expect(consumed).toBeNull();
  });
});
