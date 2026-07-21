// テナントリポジトリ (Prisma アダプタ) の契約テスト。
// 監査で発見したギャップ: tests/data/tenant-repository.memory.test.ts (メモリアダプタ) しか
// テストが無く、Tenant は Slack/Teams/Chatwork のシークレット・SSO/LINE 連携・Stripe 課金状態を
// 保持する最重要テーブルにもかかわらず、本番 Prisma アダプタでの動作検証が無かった
// (CLAUDE.md §11「メモリのみのテストは実装の誤った自信を生む」)。
// 特に updateNotificationChannels の「undefined は skip」という部分更新契約、
// listActiveTrials の日付比較・並び順、そして新規追加した recordOutboundChannelResult
// (外部通知チャネルの直近送信失敗記録) が実 DB で正しく動くかを重点的に検証する。
//
// この DB 依存テストは RUN_PRISMA_CONTRACT=1 のときだけ走り、beforeEach で全テーブルを
// TRUNCATE するため **開発 DB を指さない** こと。

import { describe, beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma';
import { buildPrismaRepos } from '@/data/adapters/prisma';

const SHOULD_RUN = process.env.RUN_PRISMA_CONTRACT === '1';

describe.runIf(SHOULD_RUN)('TenantRepository (prisma adapter)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // 各テスト前に全テーブルを空にする (Tenant 自体が対象なので他テーブルは巻き添えで空にするだけ)
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Location","Attachment","TicketHistory","TicketComment","Notification","FaqCandidate","Ticket","Category","MagicLinkToken","User","Tenant" RESTART IDENTITY CASCADE',
    );
  });

  // 新規テナントを作成できる (mode 省略時は既定の lite)
  it('新規テナントを作成できる (mode省略時はlite)', async () => {
    const repos = buildPrismaRepos(prisma);
    const tenant = await repos.tenants.create({ name: 'テスト組織' });
    expect(tenant.mode).toBe('lite');
    expect(tenant.subscriptionPlan).toBe('free');
    expect(tenant.inboundToken).toBeNull();
  });

  // inboundToken は @unique 制約でテナント間の重複を拒否する
  it('inboundTokenの重複はエラーになる (@unique制約)', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.tenants.create({ name: 'A組織', inboundToken: 'dup-token' });
    await expect(
      repos.tenants.create({ name: 'B組織', inboundToken: 'dup-token' }),
    ).rejects.toThrow();
  });

  // updateMode で Lite/Pro を切り替えられ、他テナントには波及しない
  it('updateModeは対象テナントのみを更新する', async () => {
    const repos = buildPrismaRepos(prisma);
    const a = await repos.tenants.create({ name: 'A組織', mode: 'lite' });
    const b = await repos.tenants.create({ name: 'B組織', mode: 'lite' });
    const updated = await repos.tenants.updateMode(a.id, 'pro', ['free']);
    expect(updated).toBe(true);
    const reloadedA = await repos.tenants.findById(a.id);
    const reloadedB = await repos.tenants.findById(b.id);
    expect(reloadedA?.mode).toBe('pro');
    expect(reloadedB?.mode).toBe('lite');
  });

  // 監査で発見したギャップ対応: expectedPlanIn を渡した CAS (compare-and-swap) が実 DB でも
  // 効くことの確認。現在の契約プランが許可リストに含まれない場合は更新せず false を返す
  // (Stripe Webhook 由来の自動ダウングレードと管理者操作の TOCTOU 競合防止)
  it('expectedPlanInに現在のプランが含まれない場合は更新せずfalseを返す', async () => {
    // Prisma アダプタ経由のリポジトリ束を組み立てる
    const repos = buildPrismaRepos(prisma);
    // subscriptionPlan 省略時の既定は 'free' (Tenant.create の port 契約参照)
    const tenant = await repos.tenants.create({ name: 'A組織', mode: 'lite' });
    // 現在のプラン ('free') が expectedPlanIn ('pro'/'enterprise') に含まれないため更新は不成立
    const updated = await repos.tenants.updateMode(tenant.id, 'pro', ['pro', 'enterprise']);
    // CAS が不一致で false を返すことを確認する
    expect(updated).toBe(false);
    // DB を再読込して実際にモードが変わっていないことを確認する
    const reloaded = await repos.tenants.findById(tenant.id);
    // mode は元の 'lite' のまま
    expect(reloaded?.mode).toBe('lite');
  });

  // expectedPlanIn に現在のプランが含まれる場合は実 DB でも更新される
  it('expectedPlanInに現在のプランが含まれる場合は更新される', async () => {
    // Prisma アダプタ経由のリポジトリ束を組み立てる
    const repos = buildPrismaRepos(prisma);
    // subscriptionPlan 省略時の既定は 'free' のテナントを作成する
    const tenant = await repos.tenants.create({ name: 'A組織', mode: 'lite' });
    // Stripe 連携情報の更新経由で subscriptionPlan を 'pro' にする
    await repos.tenants.updateStripeSubscription(tenant.id, { subscriptionPlan: 'pro' });
    // 現在のプラン ('pro') が expectedPlanIn に含まれるため CAS が成立し更新される
    const updated = await repos.tenants.updateMode(tenant.id, 'pro', ['pro', 'enterprise']);
    // CAS が一致で true を返すことを確認する
    expect(updated).toBe(true);
    // DB を再読込して実際に mode が変わったことを確認する
    const reloaded = await repos.tenants.findById(tenant.id);
    // mode が 'pro' に更新されている
    expect(reloaded?.mode).toBe('pro');
  });

  // updateNotificationChannels は渡したフィールドだけ更新し、undefined は現状維持する (部分更新契約)
  it('updateNotificationChannelsは指定フィールドだけ更新し他は維持する', async () => {
    const repos = buildPrismaRepos(prisma);
    const tenant = await repos.tenants.create({ name: 'A組織' });
    await repos.tenants.updateNotificationChannels(tenant.id, {
      slackWebhookUrl: 'https://hooks.slack.com/services/AAA',
      teamsWebhookUrl: 'https://teams.example/webhook',
    });
    // Slack だけ無効化する (teamsWebhookUrl は undefined = 現状維持のはず)
    const ok = await repos.tenants.updateNotificationChannels(tenant.id, {
      slackWebhookUrl: null,
    });
    expect(ok).toBe(true);
    const updated = await repos.tenants.findById(tenant.id);
    expect(updated?.slackWebhookUrl).toBeNull();
    expect(updated?.teamsWebhookUrl).toBe('https://teams.example/webhook');
  });

  // フォローアップ (監査で発見したギャップ): updateNotificationChannels の CAS (compare-and-swap)。
  // expected が現在値と食い違う (=他の管理者による並行更新) 場合は更新せず false を返す
  it('updateNotificationChannelsはexpectedが現在値と食い違うと更新せずfalseを返す', async () => {
    const repos = buildPrismaRepos(prisma);
    const tenant = await repos.tenants.create({ name: 'A組織' });
    // 並行更新を模す: 先に Slack を設定しておく
    await repos.tenants.updateNotificationChannels(tenant.id, {
      slackWebhookUrl: 'https://hooks.slack.com/services/CONCURRENT',
    });
    // 古い (null の) スナップショットを expected として渡す
    const ok = await repos.tenants.updateNotificationChannels(
      tenant.id,
      { slackWebhookUrl: 'https://hooks.slack.com/services/STALE-WRITE' },
      {
        slackWebhookUrl: null,
        teamsWebhookUrl: null,
        chatworkApiToken: null,
        chatworkRoomId: null,
      },
    );
    expect(ok).toBe(false);
    // 並行更新の値が上書きされずに残っている
    const reloaded = await repos.tenants.findById(tenant.id);
    expect(reloaded?.slackWebhookUrl).toBe('https://hooks.slack.com/services/CONCURRENT');
  });

  // フォローアップ (監査で発見したギャップ 2026-07-20): updateStripeSubscription に追加した
  // eventCreatedAt による CAS (Stripe Webhook の配信順序非保証対策) が実 DB でも効くことの確認。
  // 保存済みの stripeEventProcessedAt より古い event.created を渡すと更新されず false を返し、
  // 実際に列も変わらないこと (=古いイベントで新しい状態を巻き戻さないこと) を検証する
  it('updateStripeSubscriptionは保存済みより古いeventCreatedAtでは更新せずfalseを返す', async () => {
    const repos = buildPrismaRepos(prisma);
    const tenant = await repos.tenants.create({ name: 'A組織' });
    // 「10 分前のイベントまで適用済み」の状態を作る (先に新しいイベントを適用する)
    const newEventCreatedAt = new Date('2026-07-20T12:00:00Z');
    await repos.tenants.updateStripeSubscription(
      tenant.id,
      { subscriptionPlan: 'pro', stripeSubscriptionStatus: 'active' },
      newEventCreatedAt,
    );
    // それより 1 時間古い event.created を持つイベントが後から届いたとして更新を試みる
    const staleEventCreatedAt = new Date('2026-07-20T11:00:00Z');
    const applied = await repos.tenants.updateStripeSubscription(
      tenant.id,
      { subscriptionPlan: 'free', stripeSubscriptionStatus: 'canceled' },
      staleEventCreatedAt,
    );
    // CAS 不成立で false を返す
    expect(applied).toBe(false);
    // DB を再読込して実際に古いイベントの内容 (free/canceled) が反映されていないことを確認する
    const reloaded = await repos.tenants.findById(tenant.id);
    expect(reloaded?.subscriptionPlan).toBe('pro');
    expect(reloaded?.stripeSubscriptionStatus).toBe('active');
    // 適用済みイベント時刻も新しいイベントのままで巻き戻っていない
    expect(reloaded?.stripeEventProcessedAt?.toISOString()).toBe(newEventCreatedAt.toISOString());
  });

  // 保存済みより新しい (または未処理=null の) eventCreatedAt では通常どおり適用され、
  // stripeEventProcessedAt がそのイベントの発生時刻に更新される
  it('updateStripeSubscriptionは保存済みより新しいeventCreatedAtでは適用されstripeEventProcessedAtが更新される', async () => {
    const repos = buildPrismaRepos(prisma);
    const tenant = await repos.tenants.create({ name: 'A組織' });
    // 未処理 (stripeEventProcessedAt = null) の状態から最初のイベントを適用する
    const firstEventCreatedAt = new Date('2026-07-20T10:00:00Z');
    const firstApplied = await repos.tenants.updateStripeSubscription(
      tenant.id,
      { subscriptionPlan: 'standard' },
      firstEventCreatedAt,
    );
    expect(firstApplied).toBe(true);
    // それより新しい 2 件目のイベントも通常どおり適用される
    const secondEventCreatedAt = new Date('2026-07-20T10:05:00Z');
    const secondApplied = await repos.tenants.updateStripeSubscription(
      tenant.id,
      { subscriptionPlan: 'pro' },
      secondEventCreatedAt,
    );
    expect(secondApplied).toBe(true);
    const reloaded = await repos.tenants.findById(tenant.id);
    expect(reloaded?.subscriptionPlan).toBe('pro');
    // 適用済みイベント時刻が最新の (2 件目の) イベント発生時刻に更新されている
    expect(reloaded?.stripeEventProcessedAt?.toISOString()).toBe(
      secondEventCreatedAt.toISOString(),
    );
  });

  // recordOutboundChannelResult: 失敗記録は指定チャネルのカラムだけを更新する
  it('recordOutboundChannelResultは指定チャネルのカラムだけを更新する', async () => {
    const repos = buildPrismaRepos(prisma);
    const tenant = await repos.tenants.create({ name: 'A組織' });
    const at = new Date('2026-07-09T12:00:00Z');
    const updated = await repos.tenants.recordOutboundChannelResult(tenant.id, 'chatwork', {
      message: 'HTTP 401',
      at,
    });
    expect(updated.chatworkLastFailureAt?.toISOString()).toBe(at.toISOString());
    expect(updated.chatworkLastFailureMessage).toBe('HTTP 401');
    // 他チャネルのカラムは無関係のまま (null)
    expect(updated.slackLastFailureAt ?? null).toBeNull();
    expect(updated.teamsLastFailureAt ?? null).toBeNull();
  });

  // recordOutboundChannelResult: null を渡すと失敗記録がクリアされる (次回送信成功時を想定)
  it('recordOutboundChannelResultにnullを渡すと失敗記録がクリアされる', async () => {
    const repos = buildPrismaRepos(prisma);
    const tenant = await repos.tenants.create({ name: 'A組織' });
    await repos.tenants.recordOutboundChannelResult(tenant.id, 'slack', {
      message: 'timeout',
      at: new Date(),
    });
    const cleared = await repos.tenants.recordOutboundChannelResult(tenant.id, 'slack', null);
    expect(cleared.slackLastFailureAt ?? null).toBeNull();
    expect(cleared.slackLastFailureMessage ?? null).toBeNull();
    // 再取得しても永続化されている
    const reloaded = await repos.tenants.findById(tenant.id);
    expect(reloaded?.slackLastFailureAt ?? null).toBeNull();
  });

  // 存在しないテナント ID への記録はエラーになる (fail-closed)
  it('存在しないテナントIDへのrecordOutboundChannelResultはエラーになる', async () => {
    const repos = buildPrismaRepos(prisma);
    await expect(
      repos.tenants.recordOutboundChannelResult('no-such-tenant', 'slack', {
        message: 'x',
        at: new Date(),
      }),
    ).rejects.toThrow();
  });

  // listActiveTrials: free プランかつ trialEndsAt > now のテナントだけを、終了が近い順・上限件数で返す
  it('listActiveTrialsは進行中のfreeトライアルのみを終了が近い順に返す', async () => {
    const repos = buildPrismaRepos(prisma);
    const now = new Date('2026-07-01T00:00:00Z');
    await repos.tenants.create({
      name: 'trial-far',
      trialEndsAt: new Date('2026-07-20T00:00:00Z'),
    });
    await repos.tenants.create({
      name: 'trial-near',
      trialEndsAt: new Date('2026-07-05T00:00:00Z'),
    });
    await repos.tenants.create({
      name: 'trial-expired',
      trialEndsAt: new Date('2026-06-25T00:00:00Z'),
    });
    await repos.tenants.create({ name: 'no-trial' }); // trialEndsAt 未指定 (null)

    const result = await repos.tenants.listActiveTrials(now, 100);
    expect(result.map((t) => t.name)).toEqual(['trial-near', 'trial-far']);
  });

  // findByInboundToken: トークン一致でテナントを特定でき、他テナントとは混線しない
  it('findByInboundTokenはトークンが一致するテナントのみを返す', async () => {
    const repos = buildPrismaRepos(prisma);
    await repos.tenants.create({ name: 'A組織', inboundToken: 'token-a' });
    const b = await repos.tenants.create({ name: 'B組織', inboundToken: 'token-b' });
    const found = await repos.tenants.findByInboundToken('token-b');
    expect(found?.id).toBe(b.id);
  });

  // フォローアップ (2026-07-21): updateQuarantineNotifiedAt の原子的ゲート契約を実 DB で検証する
  const QUARANTINE_INTERVAL_MS = 24 * 60 * 60 * 1000;

  it('updateQuarantineNotifiedAtは未送信ならtrueを返し値を書き込む', async () => {
    const repos = buildPrismaRepos(prisma);
    const tenant = await repos.tenants.create({ name: 'A組織' });
    const now = new Date();
    const result = await repos.tenants.updateQuarantineNotifiedAt(
      tenant.id,
      now,
      QUARANTINE_INTERVAL_MS,
    );
    expect(result).toBe(true);
    const reloaded = await repos.tenants.findById(tenant.id);
    expect(reloaded?.quarantineNotifiedAt?.getTime()).toBe(now.getTime());
  });

  it('updateQuarantineNotifiedAtは間隔内の再呼び出しでfalseを返し上書きしない', async () => {
    const repos = buildPrismaRepos(prisma);
    const tenant = await repos.tenants.create({ name: 'A組織' });
    const first = new Date();
    await repos.tenants.updateQuarantineNotifiedAt(tenant.id, first, QUARANTINE_INTERVAL_MS);
    const second = new Date(first.getTime() + 1000);
    const result = await repos.tenants.updateQuarantineNotifiedAt(
      tenant.id,
      second,
      QUARANTINE_INTERVAL_MS,
    );
    expect(result).toBe(false);
    const reloaded = await repos.tenants.findById(tenant.id);
    expect(reloaded?.quarantineNotifiedAt?.getTime()).toBe(first.getTime());
  });
});
