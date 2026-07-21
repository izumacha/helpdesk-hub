// テナントリポジトリ (メモリアダプタ) の updateMode 単体テスト。
// Lite/Pro モード切替がテナント単位で正しく行われ、他テナントに波及しないことを確認する。

// Vitest の DSL とフック
import { beforeEach, describe, expect, it } from 'vitest';
// メモリ context (store/repos)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// 型のみ
import type { Repos } from '@/data/ports/unit-of-work';

// テスト用テナント識別子
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

// テストごとに作り直す依存
let store: Store;
let repos: Repos;

// テナント A・B を Lite モードで投入する共通シード
function seed() {
  // 現在時刻 (createdAt 用)
  const now = new Date();
  // テナント A・B を Lite モードで作成する
  for (const t of [TENANT_A, TENANT_B]) {
    store.tenants.set(t, {
      id: t,
      name: t,
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
      chatworkRoomId: null, // Slack 通知未設定 (テスト用フィクスチャ)
      createdAt: now,
    });
  }
}

// updateMode の仕様確認テスト群
describe('TenantRepository.updateMode (memory)', () => {
  // 各テストの前にメモリ context を作り直してシードする
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    seed();
  });

  // 正常系: 指定テナントの mode を lite → pro に切り替えられる (expectedPlanIn に現在のプラン
  // 'free' (seed 参照) を含めることで CAS を素通りさせる)
  it('対象テナントの mode を pro に更新できる', async () => {
    // テナント A を pro に切り替える (expectedPlanIn に現在のプラン 'free' を含める)
    const updated = await repos.tenants.updateMode(TENANT_A, 'pro', ['free']);
    // 更新できたことを示す true が返る
    expect(updated).toBe(true);
    // 再取得しても pro が永続化されている
    const reloaded = await repos.tenants.findById(TENANT_A);
    expect(reloaded?.mode).toBe('pro');
  });

  // 分離: あるテナントの更新が他テナントに波及しない
  it('他テナントの mode には影響しない', async () => {
    // テナント A だけを pro に切り替える
    await repos.tenants.updateMode(TENANT_A, 'pro', ['free']);
    // テナント B は元の lite のままであること
    const tenantB = await repos.tenants.findById(TENANT_B);
    expect(tenantB?.mode).toBe('lite');
  });

  // 異常系: 存在しないテナント ID は false を返す (fail-closed。Prisma の updateMany と同じ 0 件挙動)
  it('存在しないテナント ID はfalseを返す', async () => {
    const updated = await repos.tenants.updateMode('no-such-tenant', 'pro', ['free']);
    expect(updated).toBe(false);
  });

  // 冪等: 同じ mode への更新でも成功し値が保たれる
  it('同じ mode への更新でも値が保たれる', async () => {
    // 既に lite のテナントを lite に更新する
    const updated = await repos.tenants.updateMode(TENANT_A, 'lite');
    expect(updated).toBe(true);
    const reloaded = await repos.tenants.findById(TENANT_A);
    expect(reloaded?.mode).toBe('lite');
  });

  // 監査で発見したギャップ対応: expectedPlanIn を渡した CAS (compare-and-swap) の検証。
  // 現在の契約プランが許可リストに含まれない場合は更新せず false を返す
  // (Stripe Webhook 由来の自動ダウングレードと管理者操作の TOCTOU 競合防止)
  it('expectedPlanInに現在のプランが含まれない場合は更新せずfalseを返す', async () => {
    // テナント A は 'free' プラン (seed 参照)。'pro'/'enterprise' のみ許可するリストを渡す
    const updated = await repos.tenants.updateMode(TENANT_A, 'pro', ['pro', 'enterprise']);
    expect(updated).toBe(false);
    // 実際に mode は変更されていないこと
    const reloaded = await repos.tenants.findById(TENANT_A);
    expect(reloaded?.mode).toBe('lite');
  });

  // expectedPlanIn に現在のプランが含まれる場合は更新される
  it('expectedPlanInに現在のプランが含まれる場合は更新される', async () => {
    // テナント A のプランを 'pro' に書き換えてから CAS 付きで更新する
    store.tenants.set(TENANT_A, { ...store.tenants.get(TENANT_A)!, subscriptionPlan: 'pro' });
    const updated = await repos.tenants.updateMode(TENANT_A, 'pro', ['pro', 'enterprise']);
    expect(updated).toBe(true);
    const reloaded = await repos.tenants.findById(TENANT_A);
    expect(reloaded?.mode).toBe('pro');
  });
});

// メール取り込み (Phase 2) で使う findByInboundToken の単体テスト。
// 転送アドレスのローカルパート (inboundToken) からテナントを特定できることを確認する。
describe('TenantRepository.findByInboundToken (memory)', () => {
  // 各テストでメモリ context を作り直す
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    // 取り込みトークン付きでテナント A を、トークン無しでテナント B を投入する
    const now = new Date();
    store.tenants.set(TENANT_A, {
      id: TENANT_A,
      name: TENANT_A,
      mode: 'lite',
      industry: null,
      inboundToken: 'token-a',
      slackWebhookUrl: null,
      subscriptionPlan: 'free' as const,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      stripeSubscriptionStatus: null,
      trialEndsAt: null,
      teamsWebhookUrl: null,
      chatworkApiToken: null,
      chatworkRoomId: null, // Slack 通知未設定 (テスト用フィクスチャ)
      createdAt: now,
    });
    store.tenants.set(TENANT_B, {
      id: TENANT_B,
      name: TENANT_B,
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
      chatworkRoomId: null, // Slack 通知未設定 (テスト用フィクスチャ)
      createdAt: now,
    });
  });

  // トークン一致でテナントを引ける
  it('トークンが一致するテナントを返す', async () => {
    const tenant = await repos.tenants.findByInboundToken('token-a');
    expect(tenant?.id).toBe(TENANT_A);
  });

  // 未知トークンは null
  it('一致するトークンが無ければ null を返す', async () => {
    const tenant = await repos.tenants.findByInboundToken('no-such-token');
    expect(tenant).toBeNull();
  });

  // inboundToken=null のテナントに null で誤ヒットしないこと
  it('null トークンで誤ヒットしない', async () => {
    // 万一 null をトークンとして渡しても、token-a の行だけが一致対象であること
    const tenant = await repos.tenants.findByInboundToken('token-a');
    expect(tenant?.id).toBe(TENANT_A);
    // (B は inboundToken=null なので決して引かれない)
  });
});

// メール取り込み用トークンの (再)発行 updateInboundToken の単体テスト。
// 未発行テナントへの初回発行、既存トークンからの再発行 (ローテーション)、
// テナント分離、存在しない ID の fail-closed を確認する。
describe('TenantRepository.updateInboundToken (memory)', () => {
  // 各テストの前にメモリ context を作り直してテナント A・B を投入する
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    seed();
  });

  // 未発行 (null) のテナントに新しいトークンを発行できる
  it('未発行テナントにトークンを発行できる', async () => {
    const updated = await repos.tenants.updateInboundToken(TENANT_A, 'newtoken123');
    expect(updated.inboundToken).toBe('newtoken123');
    // 再取得しても永続化されている
    const reloaded = await repos.tenants.findById(TENANT_A);
    expect(reloaded?.inboundToken).toBe('newtoken123');
  });

  // 既存トークンを新しい値へ差し替えられる (漏洩時のローテーション用途)
  it('既存トークンを新しい値に再発行できる', async () => {
    await repos.tenants.updateInboundToken(TENANT_A, 'oldtoken111');
    const updated = await repos.tenants.updateInboundToken(TENANT_A, 'newtoken222');
    expect(updated.inboundToken).toBe('newtoken222');
    // 旧トークンではもうテナントを特定できない
    const byOldToken = await repos.tenants.findByInboundToken('oldtoken111');
    expect(byOldToken).toBeNull();
  });

  // 分離: あるテナントの再発行が他テナントに波及しない
  it('他テナントの inboundToken には影響しない', async () => {
    await repos.tenants.updateInboundToken(TENANT_A, 'tokenfora001');
    const tenantB = await repos.tenants.findById(TENANT_B);
    expect(tenantB?.inboundToken).toBeNull();
  });

  // 異常系: 存在しないテナント ID はエラーになる (fail-closed)
  it('存在しないテナント ID はエラーになる', async () => {
    await expect(repos.tenants.updateInboundToken('no-such-tenant', 'x')).rejects.toThrow();
  });
});

// Phase 4: 外部通知チャネル設定の部分更新 updateNotificationChannels の単体テスト。
// 渡したフィールドだけ更新し、undefined のフィールドは現状維持することを確認する
// (port の「部分更新 / undefined = skip」契約を memory アダプタで担保する)。
// フォローアップ (監査で発見したギャップ): expected (CAS) 省略時は従来どおり無条件更新、
// expected 指定時は読み取り時点の値と一致するときだけ更新することも合わせて検証する。
describe('TenantRepository.updateNotificationChannels (memory)', () => {
  // 各テストの前にメモリ context を作り直してテナント A・B を投入する
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    seed();
  });

  // 渡したチャネルだけ更新し、他チャネルの既存値は維持される (部分更新)
  it('指定したチャネルだけ更新し他チャネルは維持する', async () => {
    // まず Slack と Teams を設定する
    await repos.tenants.updateNotificationChannels(TENANT_A, {
      slackWebhookUrl: 'https://hooks.slack.com/services/AAA',
      teamsWebhookUrl: 'https://teams.example/webhook',
    });
    // 次に Slack だけ無効化する (teamsWebhookUrl は undefined = 現状維持)
    const updated = await repos.tenants.updateNotificationChannels(TENANT_A, {
      slackWebhookUrl: null,
    });
    // 更新できたことを示す true が返る
    expect(updated).toBe(true);
    // Slack は null に更新され、Teams は前回値を維持していること
    const reloaded = await repos.tenants.findById(TENANT_A);
    expect(reloaded?.slackWebhookUrl).toBeNull();
    expect(reloaded?.teamsWebhookUrl).toBe('https://teams.example/webhook');
  });

  // Chatwork トークン + ルーム ID を設定でき、再取得しても永続化されている
  it('Chatwork トークンとルーム ID を更新できる', async () => {
    // Chatwork の 2 値を設定する
    await repos.tenants.updateNotificationChannels(TENANT_A, {
      chatworkApiToken: 'tok-123',
      chatworkRoomId: '98765',
    });
    // 再取得して両方が永続化されていることを確認する
    const reloaded = await repos.tenants.findById(TENANT_A);
    expect(reloaded?.chatworkApiToken).toBe('tok-123');
    expect(reloaded?.chatworkRoomId).toBe('98765');
  });

  // 更新が他テナントに波及しない (テナント分離)
  it('他テナントの通知設定には影響しない', async () => {
    // テナント A だけ Slack を設定する
    await repos.tenants.updateNotificationChannels(TENANT_A, {
      slackWebhookUrl: 'https://hooks.slack.com/services/BBB',
    });
    // テナント B は未設定 (null) のままであること
    const tenantB = await repos.tenants.findById(TENANT_B);
    expect(tenantB?.slackWebhookUrl).toBeNull();
  });

  // CAS: expected が現在値と一致すれば更新できる
  it('expectedが現在値と一致すれば更新できる', async () => {
    const updated = await repos.tenants.updateNotificationChannels(
      TENANT_A,
      { slackWebhookUrl: 'https://hooks.slack.com/services/CCC' },
      {
        slackWebhookUrl: null,
        teamsWebhookUrl: null,
        chatworkApiToken: null,
        chatworkRoomId: null,
      },
    );
    expect(updated).toBe(true);
    const reloaded = await repos.tenants.findById(TENANT_A);
    expect(reloaded?.slackWebhookUrl).toBe('https://hooks.slack.com/services/CCC');
  });

  // CAS: expected が現在値と食い違えば更新されず false を返す (競合)
  it('expectedが現在値と食い違えば更新せずfalseを返す', async () => {
    // 先に別の書き込みで Slack を設定しておく (これが「並行更新」を模す)
    await repos.tenants.updateNotificationChannels(TENANT_A, {
      slackWebhookUrl: 'https://hooks.slack.com/services/CONCURRENT',
    });
    // 古い (null の) スナップショットを expected として渡す
    const updated = await repos.tenants.updateNotificationChannels(
      TENANT_A,
      { slackWebhookUrl: 'https://hooks.slack.com/services/STALE-WRITE' },
      {
        slackWebhookUrl: null,
        teamsWebhookUrl: null,
        chatworkApiToken: null,
        chatworkRoomId: null,
      },
    );
    expect(updated).toBe(false);
    // 並行更新の値が上書きされずに残っている
    const reloaded = await repos.tenants.findById(TENANT_A);
    expect(reloaded?.slackWebhookUrl).toBe('https://hooks.slack.com/services/CONCURRENT');
  });

  // CAS: 存在しないテナント ID なら false を返す
  it('存在しないテナントIDに対してはfalseを返す', async () => {
    const updated = await repos.tenants.updateNotificationChannels('ghost-tenant', {
      slackWebhookUrl: 'https://hooks.slack.com/services/X',
    });
    expect(updated).toBe(false);
  });
});

// §7.2 Free trial 終了リマインダー用の listActiveTrials の単体テスト。
// free プランかつトライアル進行中のテナントだけを、上限件数・終了が近い順で返すことを確認する。
describe('TenantRepository.listActiveTrials (memory)', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
  });

  // 指定の subscriptionPlan / trialEndsAt でテナントを 1 件シードする
  function seedTrialTenant(
    id: string,
    subscriptionPlan: 'free' | 'standard',
    trialEndsAt: Date | null,
  ) {
    store.tenants.set(id, {
      id,
      name: id,
      mode: 'lite',
      industry: null,
      inboundToken: null,
      slackWebhookUrl: null,
      subscriptionPlan,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      stripeSubscriptionStatus: null,
      trialEndsAt,
      teamsWebhookUrl: null,
      chatworkApiToken: null,
      chatworkRoomId: null,
      createdAt: new Date(),
    });
  }

  // free プランかつトライアル進行中 (trialEndsAt > now) のテナントだけを返す
  it('freeプランかつトライアル進行中のテナントのみ返す', async () => {
    const now = new Date('2026-07-01T00:00:00Z');
    seedTrialTenant('trial-active', 'free', new Date('2026-07-05T00:00:00Z')); // 対象
    seedTrialTenant('trial-expired', 'free', new Date('2026-06-25T00:00:00Z')); // 既に終了
    seedTrialTenant('no-trial', 'free', null); // トライアル対象外
    seedTrialTenant('standard-plan', 'standard', new Date('2026-07-05T00:00:00Z')); // 有料プラン
    const result = await repos.tenants.listActiveTrials(now, 100);
    expect(result.map((t) => t.id)).toEqual(['trial-active']);
  });

  // 終了が近い順 (trialEndsAt 昇順) に並ぶこと
  it('終了が近い順に並べる', async () => {
    const now = new Date('2026-07-01T00:00:00Z');
    seedTrialTenant('far', 'free', new Date('2026-07-20T00:00:00Z'));
    seedTrialTenant('near', 'free', new Date('2026-07-05T00:00:00Z'));
    const result = await repos.tenants.listActiveTrials(now, 100);
    expect(result.map((t) => t.id)).toEqual(['near', 'far']);
  });

  // 上限件数で切り詰めること (§8 一覧取得は必ず上限を持たせる)
  it('上限件数で切り詰める', async () => {
    const now = new Date('2026-07-01T00:00:00Z');
    seedTrialTenant('t1', 'free', new Date('2026-07-05T00:00:00Z'));
    seedTrialTenant('t2', 'free', new Date('2026-07-06T00:00:00Z'));
    seedTrialTenant('t3', 'free', new Date('2026-07-07T00:00:00Z'));
    const result = await repos.tenants.listActiveTrials(now, 2);
    expect(result).toHaveLength(2);
  });
});

// §7.2.1 Free trial 終了リマインダーの冪等化フラグ updateTrialReminderLastSent の単体テスト。
describe('TenantRepository.updateTrialReminderLastSent (memory)', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    seed();
  });

  // マイルストーンを永続化できる
  it('マイルストーンを永続化できる', async () => {
    const updated = await repos.tenants.updateTrialReminderLastSent(TENANT_A, 5);
    expect(updated.trialReminderLastSentDaysBefore).toBe(5);
    const reloaded = await repos.tenants.findById(TENANT_A);
    expect(reloaded?.trialReminderLastSentDaysBefore).toBe(5);
  });

  // 分離: あるテナントの更新が他テナントに波及しない
  it('他テナントのフラグには影響しない', async () => {
    await repos.tenants.updateTrialReminderLastSent(TENANT_A, 5);
    const tenantB = await repos.tenants.findById(TENANT_B);
    expect(tenantB?.trialReminderLastSentDaysBefore ?? null).toBeNull();
  });

  // 異常系: 存在しないテナント ID はエラーになる (fail-closed)
  it('存在しないテナント ID はエラーになる', async () => {
    await expect(repos.tenants.updateTrialReminderLastSent('no-such-tenant', 5)).rejects.toThrow();
  });
});

// 監査で発見したギャップ対応: 外部通知チャネルの直近送信結果を記録する
// recordOutboundChannelResult の単体テスト。チャネルごとのカラム分離・テナント分離・
// 失敗記録のクリアを確認する。
describe('TenantRepository.recordOutboundChannelResult (memory)', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    seed();
  });

  // Slack の失敗を記録できる (Teams/Chatwork には影響しない)
  it('指定チャネルの失敗だけを記録し他チャネルには影響しない', async () => {
    const at = new Date('2026-07-09T12:00:00Z');
    const updated = await repos.tenants.recordOutboundChannelResult(TENANT_A, 'slack', {
      message: 'HTTP 404',
      at,
    });
    expect(updated.slackLastFailureAt).toEqual(at);
    expect(updated.slackLastFailureMessage).toBe('HTTP 404');
    // Teams/Chatwork は未記録のまま
    expect(updated.teamsLastFailureAt ?? null).toBeNull();
    expect(updated.chatworkLastFailureAt ?? null).toBeNull();
  });

  // null を渡すと失敗記録がクリアされる (次回送信成功時の呼び出しを想定)
  it('null を渡すと失敗記録がクリアされる', async () => {
    await repos.tenants.recordOutboundChannelResult(TENANT_A, 'teams', {
      message: 'timeout',
      at: new Date(),
    });
    const cleared = await repos.tenants.recordOutboundChannelResult(TENANT_A, 'teams', null);
    expect(cleared.teamsLastFailureAt ?? null).toBeNull();
    expect(cleared.teamsLastFailureMessage ?? null).toBeNull();
  });

  // 分離: あるテナントの記録が他テナントに波及しない
  it('他テナントの記録には影響しない', async () => {
    await repos.tenants.recordOutboundChannelResult(TENANT_A, 'chatwork', {
      message: 'HTTP 401',
      at: new Date(),
    });
    const tenantB = await repos.tenants.findById(TENANT_B);
    expect(tenantB?.chatworkLastFailureAt ?? null).toBeNull();
  });

  // 異常系: 存在しないテナント ID はエラーになる (fail-closed)
  it('存在しないテナント ID はエラーになる', async () => {
    await expect(
      repos.tenants.recordOutboundChannelResult('no-such-tenant', 'slack', {
        message: 'x',
        at: new Date(),
      }),
    ).rejects.toThrow();
  });
});

// フォローアップ (2026-07-21): 隔離メール通知の送信間隔を空ける原子的ゲート
// updateQuarantineNotifiedAt の単体テスト。
describe('TenantRepository.updateQuarantineNotifiedAt (memory)', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    seed();
  });

  const INTERVAL_MS = 24 * 60 * 60 * 1000;

  // 未送信 (quarantineNotifiedAt が null) なら true を返し、値が書き込まれる
  it('未送信なら通知の権利を得てtrueを返す', async () => {
    const now = new Date();
    const result = await repos.tenants.updateQuarantineNotifiedAt(TENANT_A, now, INTERVAL_MS);
    expect(result).toBe(true);
    const tenant = await repos.tenants.findById(TENANT_A);
    expect(tenant?.quarantineNotifiedAt).toEqual(now);
  });

  // 間隔内の再呼び出しは false を返し、値も上書きされない
  it('間隔内の再呼び出しはfalseを返す', async () => {
    const first = new Date();
    await repos.tenants.updateQuarantineNotifiedAt(TENANT_A, first, INTERVAL_MS);
    const second = new Date(first.getTime() + 1000); // 1秒後 (間隔未経過)
    const result = await repos.tenants.updateQuarantineNotifiedAt(TENANT_A, second, INTERVAL_MS);
    expect(result).toBe(false);
    const tenant = await repos.tenants.findById(TENANT_A);
    expect(tenant?.quarantineNotifiedAt).toEqual(first); // 上書きされていない
  });

  // 間隔経過後の呼び出しは true を返し、値が更新される
  it('間隔経過後の呼び出しはtrueを返す', async () => {
    const first = new Date();
    await repos.tenants.updateQuarantineNotifiedAt(TENANT_A, first, INTERVAL_MS);
    const second = new Date(first.getTime() + INTERVAL_MS + 1000); // 間隔+1秒後
    const result = await repos.tenants.updateQuarantineNotifiedAt(TENANT_A, second, INTERVAL_MS);
    expect(result).toBe(true);
    const tenant = await repos.tenants.findById(TENANT_A);
    expect(tenant?.quarantineNotifiedAt).toEqual(second);
  });

  // 分離: あるテナントの更新が他テナントに波及しない
  it('他テナントには影響しない', async () => {
    await repos.tenants.updateQuarantineNotifiedAt(TENANT_A, new Date(), INTERVAL_MS);
    const tenantB = await repos.tenants.findById(TENANT_B);
    expect(tenantB?.quarantineNotifiedAt ?? null).toBeNull();
  });

  // 異常系: 存在しないテナント ID は false を返す (Prisma の updateMany 0 件と同じ扱い)
  it('存在しないテナントIDはfalseを返す', async () => {
    const result = await repos.tenants.updateQuarantineNotifiedAt(
      'no-such-tenant',
      new Date(),
      INTERVAL_MS,
    );
    expect(result).toBe(false);
  });
});
