// POST /api/internal/trial-reminders (§7.2 Free trial 終了リマインダー) のテスト。
// 共有シークレット認証 (未設定/欠落/不一致)・リマインダー対象日の判定・
// 1テナントの送信失敗が他テナントを止めないことをメモリアダプタで検証する。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// レート制限バケットをテスト間で初期化するヘルパー
import { __resetRateLimits } from '@/lib/rate-limit';
// 「上限までは429にならず、上限+1回目で429になる」の共通アサーションヘルパー
import { expectRateLimitTripsAfter } from './sso-rate-limit-assertions';
// メモリ実装の context (store/repos)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// リポジトリ束の型
import type { Repos } from '@/data/ports/unit-of-work';
// EmailSender 型 (fake 実装で利用)
import type { EmailSender } from '@/lib/email';

const CRON_SECRET = 'test-cron-secret-value';

// 各テストで差し替える可変な依存 (Route import 前に値を入れる)
let store: Store;
let repos: Repos;
// EmailSender への呼び出しを記録するフェイク
let sentMessages: { to: string; subject: string }[] = [];

// @/data を差し替え (getter で beforeEach の上書きを反映)
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

// EmailSender ファクトリを差し替え。send は既定で記録するだけだが、
// テストから throw に差し替えたいケースのために stub にしておく (request-magic-link.test.ts と同じ方式)
let sendImpl: (message: { to: string; subject: string }) => Promise<void> = async (message) => {
  sentMessages.push(message);
};
const getEmailSenderImpl: () => EmailSender = () => ({
  async send(message) {
    await sendImpl(message);
  },
});
vi.mock('@/lib/email', () => ({
  getEmailSender: () => getEmailSenderImpl(),
}));

// 動的 import: 上のモック設定が反映された後で対象を読み込む
async function loadRoute() {
  const mod = await import('@/app/api/internal/trial-reminders/route');
  return mod.POST;
}

// 認証済みリクエストを組み立てるヘルパー (token 省略時は正しいシークレットを使う)
function makeRequest(token?: string): Request {
  const headers = new Headers();
  if (token !== null) {
    headers.set('authorization', `Bearer ${token ?? CRON_SECRET}`);
  }
  return new Request('http://localhost/api/internal/trial-reminders', {
    method: 'POST',
    headers,
  });
}

// 指定の trialEndsAt / subscriptionPlan / 送信済みマイルストーンでテナントをシードする
function seedTenant(
  id: string,
  trialEndsAt: Date | null,
  subscriptionPlan: 'free' | 'standard' = 'free',
  trialReminderLastSentDaysBefore: number | null = null,
) {
  store.tenants.set(id, {
    id,
    name: `テナント${id}`,
    mode: 'lite',
    industry: null,
    inboundToken: null,
    slackWebhookUrl: null,
    subscriptionPlan,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    trialEndsAt,
    trialReminderLastSentDaysBefore,
    teamsWebhookUrl: null,
    chatworkApiToken: null,
    chatworkRoomId: null,
    createdAt: new Date(),
  });
}

// 指定テナントに admin ユーザーを 1 件追加する
function seedAdmin(tenantId: string, email: string) {
  const now = new Date();
  store.users.set(`admin-${tenantId}`, {
    id: `admin-${tenantId}`,
    email,
    name: '管理者',
    passwordHash: 'x',
    role: 'admin',
    tenantId,
    createdAt: now,
    updatedAt: now,
    lineUserId: null,
    lineLinkCodeHash: null,
    lineLinkCodeExpiresAt: null,
  });
}

describe('POST /api/internal/trial-reminders', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    sentMessages = [];
    sendImpl = async (message) => {
      sentMessages.push(message);
    };
    vi.stubEnv('TRIAL_REMINDER_CRON_SECRET', CRON_SECRET);
    // 監査で発見したギャップ対応で追加したレート制限のバケットをテスト間でクリアする
    // (このファイルは 1 テストあたり複数回 POST するため、リセットしないと後続のテストが
    // 前のテストのカウントを引き継いで意図せず 429 になってしまう)
    __resetRateLimits();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // fail-closed: シークレット未設定なら処理せず 500 を返す
  it('シークレット未設定時は処理せず500を返す', async () => {
    vi.stubEnv('TRIAL_REMINDER_CRON_SECRET', '');
    seedTenant('t1', new Date(Date.now() + 5 * 24 * 60 * 60 * 1000));
    seedAdmin('t1', 'admin@example.com');
    const POST = await loadRoute();
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
    expect(sentMessages).toHaveLength(0);
  });

  // Authorization ヘッダが無ければ 401
  it('Authorizationヘッダが無ければ401を返す', async () => {
    const POST = await loadRoute();
    const res = await POST(makeRequest(null as unknown as string));
    expect(res.status).toBe(401);
  });

  // トークンが不一致なら 401
  it('トークン不一致は401を返す', async () => {
    const POST = await loadRoute();
    const res = await POST(makeRequest('wrong-token'));
    expect(res.status).toBe(401);
  });

  // 残り5日ちょうどのテナントには送信する
  it.each([5, 1])('残り%s日ちょうどのテナントにリマインダーを送る', async (days) => {
    seedTenant('t1', new Date(Date.now() + days * 24 * 60 * 60 * 1000));
    seedAdmin('t1', 'admin@example.com');
    const POST = await loadRoute();
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.remindersSent).toBe(1);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].to).toBe('admin@example.com');
  });

  // まだどのマイルストーンにも達していなければ送信しない
  it('マイルストーン未到達なら送信しない', async () => {
    seedTenant('t1', new Date(Date.now() + 6 * 24 * 60 * 60 * 1000));
    seedAdmin('t1', 'admin@example.com');
    const POST = await loadRoute();
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.remindersSent).toBe(0);
    expect(sentMessages).toHaveLength(0);
  });

  // 既に同じマイルストーンを送信済みなら再送しない (workflow_dispatch の手動再実行や
  // 同日の複数回実行での二重送信防止)
  it('送信済みのマイルストーンは再送しない', async () => {
    seedTenant('t1', new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), 'free', 5);
    seedAdmin('t1', 'admin@example.com');
    const POST = await loadRoute();
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.remindersSent).toBe(0);
    expect(sentMessages).toHaveLength(0);
  });

  // 5日のマイルストーンを送信済みでも、1日のマイルストーンに新たに到達すれば送信する
  it('次のマイルストーンには送信する', async () => {
    seedTenant('t1', new Date(Date.now() + 1 * 24 * 60 * 60 * 1000), 'free', 5);
    seedAdmin('t1', 'admin@example.com');
    const POST = await loadRoute();
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.remindersSent).toBe(1);
    expect(sentMessages).toHaveLength(1);
  });

  // 送信成功後は trialReminderLastSentDaysBefore が永続化されること
  it('送信成功後にマイルストーンを永続化する', async () => {
    seedTenant('t1', new Date(Date.now() + 5 * 24 * 60 * 60 * 1000));
    seedAdmin('t1', 'admin@example.com');
    const POST = await loadRoute();
    await POST(makeRequest());
    expect(store.tenants.get('t1')?.trialReminderLastSentDaysBefore).toBe(5);
  });

  // 送信は成功したが永続化 (updateTrialReminderLastSent) が失敗した場合、
  // remindersSent は加算しない (次回実行時の再試行対象として正しく報告する)
  it('永続化が失敗した場合はremindersSentを加算しない', async () => {
    seedTenant('t1', new Date(Date.now() + 5 * 24 * 60 * 60 * 1000));
    seedAdmin('t1', 'admin@example.com');
    // updateTrialReminderLastSent だけ失敗するよう差し替える
    repos.tenants.updateTrialReminderLastSent = async () => {
      throw new Error('DB 接続エラー (テスト用)');
    };
    const POST = await loadRoute();
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    // メール自体は送られている (副作用は戻せない) が、永続化失敗のため未送信扱いで報告する
    expect(sentMessages).toHaveLength(1);
    expect(body.remindersSent).toBe(0);
  });

  // standard プラン (トライアル対象外) には送信しない
  it('Standardプランのテナントは対象外', async () => {
    seedTenant('t1', new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), 'standard');
    seedAdmin('t1', 'admin@example.com');
    const POST = await loadRoute();
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.remindersSent).toBe(0);
  });

  // admin が 1 人もいないテナントはスキップする (異常データへの防御)
  it('管理者が居ないテナントはスキップする', async () => {
    seedTenant('t1', new Date(Date.now() + 5 * 24 * 60 * 60 * 1000));
    // admin を追加しない
    const POST = await loadRoute();
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.remindersSent).toBe(0);
    expect(sentMessages).toHaveLength(0);
  });

  // 1 テナントの送信失敗が他テナントへの送信を止めない
  it('1テナントの送信失敗が他テナントの送信を妨げない', async () => {
    seedTenant('t-fail', new Date(Date.now() + 5 * 24 * 60 * 60 * 1000));
    seedAdmin('t-fail', 'fail@example.com');
    seedTenant('t-ok', new Date(Date.now() + 5 * 24 * 60 * 60 * 1000));
    seedAdmin('t-ok', 'ok@example.com');
    // fail@example.com への送信だけ失敗させる
    sendImpl = async (message) => {
      if (message.to === 'fail@example.com') throw new Error('SMTP down');
      sentMessages.push(message);
    };
    const POST = await loadRoute();
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    // 失敗したテナントはカウントされないが、成功したテナントは送信済みになる
    expect(body.remindersSent).toBe(1);
    expect(sentMessages.map((m) => m.to)).toEqual(['ok@example.com']);
    // 失敗したテナントはマイルストーンを永続化しない (次回実行時に再試行できるようにする)
    expect(store.tenants.get('t-fail')?.trialReminderLastSentDaysBefore).toBeNull();
    // 成功したテナントは永続化される
    expect(store.tenants.get('t-ok')?.trialReminderLastSentDaysBefore).toBe(5);
  });

  // 監査で発見したギャップ対応: 共有シークレットのみで守られたこの経路にレート制限が無く、
  // シークレット漏洩時に無制限に叩けてしまっていた。固定キーのレート制限 (60秒5回) を追加した
  describe('レート制限 (監査で発見したギャップ対応)', () => {
    // 上限 (5回/60秒) を超えると、認証結果 (トークン不一致) より前に429を返す
    it('固定キーのレート制限を超えると429を返す', async () => {
      const POST = await loadRoute();
      await expectRateLimitTripsAfter(() => POST(makeRequest('wrong-token')), 5);
    });
  });
});
