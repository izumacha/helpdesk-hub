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
    await repos.tenants.updateMode(a.id, 'pro');
    const reloadedA = await repos.tenants.findById(a.id);
    const reloadedB = await repos.tenants.findById(b.id);
    expect(reloadedA?.mode).toBe('pro');
    expect(reloadedB?.mode).toBe('lite');
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
    const updated = await repos.tenants.updateNotificationChannels(tenant.id, {
      slackWebhookUrl: null,
    });
    expect(updated.slackWebhookUrl).toBeNull();
    expect(updated.teamsWebhookUrl).toBe('https://teams.example/webhook');
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
    await repos.tenants.create({ name: 'trial-expired', trialEndsAt: new Date('2026-06-25T00:00:00Z') });
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
});
