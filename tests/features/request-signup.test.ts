// Vitest のテスト DSL とモック機能
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ実装の context (store/repos)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// リポジトリ束の型
import type { Repos } from '@/data/ports/unit-of-work';
// EmailSender 型 (fake 実装で利用)
import type { EmailSender } from '@/lib/email';
// サインアップトークンのハッシュ化 (fake send 内で URL に含まれるトークンを取り出すために使う)
import { hashSignupToken } from '@/lib/signup';
// レート制限バケットをテスト間で初期化するためのヘルパー (グローバル Map の汚染を防ぐ)
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

// EmailSender ファクトリを差し替え (request-magic-link.test.ts と同じパターン)
let sendImpl: (message: {
  to: string;
  subject: string;
  html: string;
  text: string;
}) => Promise<void> = async (message) => {
  sentMessages.push(message);
};
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
  const mod = await import('@/features/auth/actions/request-signup');
  return mod.requestSignup;
}

// テストごとにクリーンな状態にする
beforeEach(() => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  sentMessages = [];
  sendImpl = async (message) => {
    sentMessages.push(message);
  };
  getEmailSenderImpl = () => ({
    async send(message) {
      await sendImpl(message);
    },
  });
  // レート制限バケットはモジュールグローバルなので、他テストの影響を受けないよう初期化する
  __resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
  // 次のテストに影響しないよう、このテストで消費したバケットも初期化しておく
  __resetRateLimits();
});

describe('requestSignup', () => {
  // 未登録メールなら SignupToken が発行され、完了ページへのリンクを含むメールが送られること
  it('未登録メールなら SignupToken を発行し完了リンクをメール送信する', async () => {
    const requestSignup = await loadAction();
    const result = await requestSignup({ email: 'founder@example.com' });

    // 戻り値は常に ok
    expect(result).toEqual({ ok: true });
    // メールが 1 件送信されている
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].to).toBe('founder@example.com');
    // /signup/complete?token=... の URL が本文に含まれる
    const match = sentMessages[0].text.match(
      /https?:\/\/\S+\/signup\/complete\?token=([A-Za-z0-9_-]+)/,
    );
    expect(match).not.toBeNull();
    const rawTokenFromEmail = match![1];

    // DB にはハッシュが 1 件保存されている (生トークンは保存されていない)
    expect(store.signupTokens.size).toBe(1);
    const stored = [...store.signupTokens.values()][0];
    expect(stored.tokenHash).toBe(await hashSignupToken(rawTokenFromEmail));
    expect(stored.tokenHash).not.toBe(rawTokenFromEmail);
    expect(stored.consumedAt).toBeNull();
    // 通常のログイン用マジックリンクは発行されていない (新規サインアップ経路)
    expect(store.magicLinks.size).toBe(0);
  });

  // 監査で発見したギャップ対応: 再送すると古いトークンは無効化され、新しいトークンだけが使える
  it('サインアップリンクを再送すると、古いリンクは無効化され新しいリンクだけが使える', async () => {
    const requestSignup = await loadAction();

    // 1 回目のリクエストでトークンを発行する
    await requestSignup({ email: 'reissue@example.com' });
    expect(sentMessages).toHaveLength(1);
    const firstMatch = sentMessages[0].text.match(
      /https?:\/\/\S+\/signup\/complete\?token=([A-Za-z0-9_-]+)/,
    );
    const firstRawToken = firstMatch![1];

    // 2 回目のリクエスト (再送) で新しいトークンを発行する
    await requestSignup({ email: 'reissue@example.com' });
    expect(sentMessages).toHaveLength(2);

    // 古いトークンはもう consumeValidToken で使えない (消費済み扱い)
    const firstTokenHash = await hashSignupToken(firstRawToken);
    const consumed = await repos.signupTokens.consumeValidToken({
      tokenHash: firstTokenHash,
      now: new Date(),
    });
    expect(consumed).toBeNull();
  });

  // 既存ユーザーのメールで要求された場合は、新しいテナントを作らず通常のログイン用
  // マジックリンクを送ること (列挙耐性: 応答からは経路の違いが分からない)
  it('既存ユーザーのメールでは SignupToken を発行せずログイン用マジックリンクを送る', async () => {
    // 既存テナント + ユーザーを seed
    store.tenants.set('t-1', {
      id: 't-1',
      name: '既存組織',
      mode: 'lite',
      industry: null,
      inboundToken: null,
      slackWebhookUrl: null,
      subscriptionPlan: 'free' as const,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      stripeSubscriptionStatus: null,
      trialEndsAt: null,
      teamsWebhookUrl: null,
      chatworkApiToken: null,
      chatworkRoomId: null,
      createdAt: new Date(),
    });
    store.users.set('u-1', {
      id: 'u-1',
      email: 'existing@example.com',
      name: '既存管理者',
      passwordHash: 'x',
      role: 'admin',
      tenantId: 't-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const requestSignup = await loadAction();
    const result = await requestSignup({ email: 'existing@example.com' });

    // 戻り値は常に ok (新規/既存で応答が変わらない)
    expect(result).toEqual({ ok: true });
    // SignupToken は発行されない
    expect(store.signupTokens.size).toBe(0);
    // 代わりに通常のログイン用マジックリンクが 1 件発行される
    expect(store.magicLinks.size).toBe(1);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].to).toBe('existing@example.com');
    // ログインリンクの URL (/api/auth/magic-link/callback) が本文に含まれる (サインアップ完了リンクではない)
    expect(sentMessages[0].text).toMatch(/\/api\/auth\/magic-link\/callback\?token=/);
  });

  // 不正なメール形式は例外で弾かれること
  it('メール形式が不正なら例外を投げる', async () => {
    const requestSignup = await loadAction();
    await expect(requestSignup({ email: 'not-an-email' })).rejects.toThrow(/メールアドレス/);
  });

  // メール送信が失敗しても呼び出し側には {ok: true} を返すこと (列挙耐性)
  it('メール送信が失敗しても呼び出し側からは {ok: true} に見える', async () => {
    sendImpl = async () => {
      throw new Error('simulated SMTP outage');
    };
    const requestSignup = await loadAction();
    const result = await requestSignup({ email: 'fail@example.com' });
    expect(result).toEqual({ ok: true });
  });

  // メール送信失敗時にはトークン行が削除されること (rate-limit を消費しない)
  it('メール送信失敗時にトークン行が削除される (rate-limit 枠を消費しない)', async () => {
    let attempt = 0;
    sendImpl = async (message) => {
      attempt += 1;
      if (attempt === 1) throw new Error('first attempt fails');
      sentMessages.push(message);
    };
    const requestSignup = await loadAction();
    // 1 回目: 失敗するが {ok:true} を返し、行は削除されているはず
    await requestSignup({ email: 'flaky@example.com' });
    expect(store.signupTokens.size).toBe(0);
    // 2 回目: 成功して 1 件残る
    await requestSignup({ email: 'flaky@example.com' });
    expect(store.signupTokens.size).toBe(1);
    expect(sentMessages).toHaveLength(1);
  });

  // 同一メール宛に短時間で大量に要求しても、上限を超えたらメール送信されないこと (発行スパム対策)
  it('レート制限: 同一メール宛 15 分以内 5 通を超えると新規発行されない', async () => {
    const requestSignup = await loadAction();
    // 上限 (5 件) ぴったりまでは発行が許される
    for (let i = 0; i < 5; i++) {
      await requestSignup({ email: 'rate@example.com' });
    }
    expect(store.signupTokens.size).toBe(5);
    expect(sentMessages).toHaveLength(5);

    // 6 件目はレート制限で発行されない (戻り値は ok のまま、副作用なし)
    const result = await requestSignup({ email: 'rate@example.com' });
    expect(result).toEqual({ ok: true });
    expect(store.signupTokens.size).toBe(5);
    expect(sentMessages).toHaveLength(5);
  });

  // /code-review ultra 指摘対応 (2026-07-13): メール単位のレート制限は毎回異なるメール
  // アドレスを使えば回避できてしまうため、エンドポイント全体の頭打ちが機能することを確認する。
  // この上限超過は列挙耐性の対象外 (どのメールでも同じ「混み合っている」エラーになるため
  // 詮索の手がかりにならない) なので、列挙耐性テストと異なり例外が伝播することを検証する
  it('レート制限: 異なるメールアドレスを使ってもエンドポイント全体の上限 (1分20件) で頭打ちになる', async () => {
    const requestSignup = await loadAction();
    // 上限 (20 件) ぴったりまでは、異なるメールアドレスでも発行が許される
    for (let i = 0; i < 20; i++) {
      await requestSignup({ email: `flood-${i}@example.com` });
    }
    expect(store.signupTokens.size).toBe(20);

    // 21 件目は別のメールアドレスでも、全体レート制限に引っかかり例外を投げる
    await expect(requestSignup({ email: 'flood-overflow@example.com' })).rejects.toThrow(
      /頻度が高すぎます/,
    );
    // 上限超過分は発行されていないこと
    expect(store.signupTokens.size).toBe(20);
  });
});
