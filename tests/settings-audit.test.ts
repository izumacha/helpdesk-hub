// recordSettingsAudit (src/lib/settings-audit.ts) の仕様確認テスト。
// /code-review ultra 指摘対応: SSO/LINE/通知チャネル (§4.2) + テナントモード/拠点CRUD/
// 転送先アドレス再発行 (§4.3) の計 10 箇所に複製されていた「try/catch で監査ログ書き込みを
// 囲み、失敗してもログに残すだけで呼び出し元の操作結果には影響させない」処理を集約した先。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos } from '@/data/ports/unit-of-work';

const TENANT = 'default-tenant';
const ACTOR = 'u-admin-1';

let store: Store;
let repos: Repos;

// @/data を差し替え (getter で beforeEach の上書きを反映)
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

beforeEach(() => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  store.tenants.set(TENANT, {
    id: TENANT,
    name: 'デフォルト組織',
    mode: 'lite',
    industry: null,
    inboundToken: null,
    slackWebhookUrl: null,
    subscriptionPlan: 'free',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    trialEndsAt: null,
    teamsWebhookUrl: null,
    chatworkApiToken: null,
    chatworkRoomId: null,
    createdAt: new Date(),
  });
  store.users.set(ACTOR, {
    id: ACTOR,
    email: 'admin@example.com',
    name: '管理者',
    passwordHash: 'x',
    role: 'admin',
    tenantId: TENANT,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

describe('recordSettingsAudit', () => {
  // 正常系: 指定したアクションで監査ログが 1 件記録される
  it('監査ログを記録する', async () => {
    const { recordSettingsAudit } = await import('@/lib/settings-audit');
    await recordSettingsAudit({
      tenantId: TENANT,
      actorId: ACTOR,
      action: 'location_create',
      logPrefix: '[test]',
    });
    const logs = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('location_create');
    expect(logs[0].actorId).toBe(ACTOR);
  });

  // 異常系: 記録自体が失敗しても throw せず、ログに残すだけで正常終了する
  // (呼び出し元の Server Action が「保存/削除に失敗した」という誤ったエラーを
  // 表示しないようにするための最重要の契約)
  it('記録が失敗してもthrowしない', async () => {
    vi.spyOn(repos.settingsAudit, 'record').mockRejectedValueOnce(new Error('DB down'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { recordSettingsAudit } = await import('@/lib/settings-audit');

    await expect(
      recordSettingsAudit({
        tenantId: TENANT,
        actorId: ACTOR,
        action: 'tenant_mode_update',
        logPrefix: '[test]',
      }),
    ).resolves.toBeUndefined();

    // 渡した logPrefix がエラーログに使われていること
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[test]'),
      expect.any(Error),
    );
    consoleErrorSpy.mockRestore();
  });
});
