// createInvitationsBulk (一括発行) のテスト。
// docs/smb-dx-pivot-plan.md §7.1 フォローアップ (2026-07-10): 「メンバーを招待（リンク貼り付け
// or CSV）」の CSV 経路。バッチ全体のレート制限・部分成功・シート上限を検証する。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos } from '@/data/ports/unit-of-work';
import { __resetRateLimits } from '@/lib/rate-limit';
import type { SubscriptionPlan } from '@/domain/types';
// レート制限の上限値 (マジックナンバーを避け、テストの意図を定数から導出するため)
import { INVITE_RATE_LIMIT_MAX } from '@/lib/invite';

const TENANT_ID = 'tenant-1';
const ADMIN_ID = 'u-admin-1';

let store: Store;
let repos: Repos;

vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

vi.mock('@/lib/auth', () => ({
  auth: async () => ({
    user: { id: ADMIN_ID, role: 'admin', tenantId: TENANT_ID },
  }),
}));

const { sentEmails } = vi.hoisted(() => ({
  sentEmails: [] as Array<{ to: string; subject: string }>,
}));
vi.mock('@/lib/email', () => ({
  getEmailSender: () => ({
    send: async (message: { to: string; subject: string }) => {
      sentEmails.push(message);
    },
  }),
}));

function seedTenant(plan: SubscriptionPlan) {
  const now = new Date();
  store.tenants.set(TENANT_ID, {
    id: TENANT_ID,
    name: 'テスト組織',
    mode: 'lite',
    industry: null,
    inboundToken: null,
    slackWebhookUrl: null,
    subscriptionPlan: plan,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    trialEndsAt: null,
    teamsWebhookUrl: null,
    chatworkApiToken: null,
    chatworkRoomId: null,
    createdAt: now,
  });
  store.users.set(ADMIN_ID, {
    id: ADMIN_ID,
    email: 'admin@example.com',
    name: '管理者',
    passwordHash: 'x',
    role: 'admin',
    tenantId: TENANT_ID,
    createdAt: now,
    updatedAt: now,
  });
}

function makeForm(role: string, emails: string): FormData {
  const fd = new FormData();
  fd.set('role', role);
  fd.set('emails', emails);
  return fd;
}

beforeEach(() => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  vi.resetModules();
  __resetRateLimits();
  sentEmails.length = 0;
});

describe('createInvitationsBulk', () => {
  it('複数行のメールアドレスからまとめて招待リンクを発行する', async () => {
    seedTenant('standard');
    const { createInvitationsBulk } =
      await import('@/features/settings/actions/create-invitations-bulk');

    const result = await createInvitationsBulk(
      makeForm('requester', 'a@example.com\nb@example.com\nc@example.com'),
    );

    expect(result.results).toHaveLength(3);
    expect(result.results.every((r) => r.ok)).toBe(true);
    expect(result.results.map((r) => r.email)).toEqual([
      'a@example.com',
      'b@example.com',
      'c@example.com',
    ]);
    // 全員に案内メールが届く
    expect(sentEmails).toHaveLength(3);
    // DB にも 3 件の招待行が作られている
    expect([...store.invitations.values()]).toHaveLength(3);
  });

  // フォローアップ (2026-07-11): バッチ全体で監査ログは 1 件だけ (行ごとに積み上がらない)。
  // importTickets が 200 件のインポートでも通知を 1 通にまとめるのと同じ「まとめて 1 回」方針。
  it('成功した場合バッチ全体で監査ログが1件だけ記録される', async () => {
    seedTenant('standard');
    const { createInvitationsBulk } =
      await import('@/features/settings/actions/create-invitations-bulk');

    await createInvitationsBulk(
      makeForm('requester', 'a@example.com\nb@example.com\nc@example.com'),
    );

    const auditLogs = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT_ID });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('invitation_issue');
    expect(auditLogs[0].actorId).toBe(ADMIN_ID);
  });

  // バッチ全体が拒否され1件も発行されなかった場合は、何も付与していないため監査ログも記録しない
  it('バッチ全体が拒否された場合は監査ログも記録されない', async () => {
    seedTenant('standard');
    const { createInvitationsBulk } =
      await import('@/features/settings/actions/create-invitations-bulk');

    await expect(createInvitationsBulk(makeForm('requester', '   \n  '))).rejects.toThrow();

    const auditLogs = await repos.settingsAudit.findAllByTenant({ tenantId: TENANT_ID });
    expect(auditLogs).toHaveLength(0);
  });

  // メールアドレスを 1 件も指定しないとバッチ全体を拒否する (Zod の min(1) による)
  it('メールアドレスが1件も無い場合はエラーになる', async () => {
    seedTenant('standard');
    const { createInvitationsBulk } =
      await import('@/features/settings/actions/create-invitations-bulk');

    await expect(createInvitationsBulk(makeForm('requester', '   \n  '))).rejects.toThrow(
      /1 件以上/,
    );
  });

  // 不正な形式のメールアドレスが 1 件でも混ざっているとバッチ全体を拒否する
  // (どの行が原因か分からないまま一部だけ発行されるより、直してから再送してもらう方が安全)
  it('不正な形式のメールアドレスが混ざっている場合はバッチ全体を拒否する', async () => {
    seedTenant('standard');
    const { createInvitationsBulk } =
      await import('@/features/settings/actions/create-invitations-bulk');

    await expect(
      createInvitationsBulk(makeForm('requester', 'a@example.com\nnot-an-email')),
    ).rejects.toThrow(/正しいメールアドレス/);
    // 1 件も発行されていないこと (部分実行しない)
    expect([...store.invitations.values()]).toHaveLength(0);
  });

  // Standard プランはスタッフ (agent) 10 名まで。8 名いる状態 (残り枠 2) で 5 名分を
  // 一括招待すると、1 件も発行せずバッチ全体を拒否する。
  // /code-review ultra 指摘対応 (2026-07-10): 当初の実装は issueInvitation 内で行ごとに
  // checkSeatAvailability を呼んでいたが、招待の発行自体は実ユーザー数を増やさないため、
  // バッチ内の全行が同じ「空きあり」判定を受け取り、残り枠を超えて発行できてしまっていた
  // (このテスト自身も当初は okCount > 0 という弱いアサーションで、その過剰発行を検出できて
  // いなかった)。バッチ全体を先に見積もり、レート制限と同じ「1件も発行しない」方針に修正した。
  it('シート残り枠を超えるバッチは1件も発行せず拒否する', async () => {
    seedTenant('standard');
    const now = new Date();
    // Standard プランの上限 10 名のうち、既存エージェント 7 名 + admin (seedTenant で投入済み) の
    // 計 8 名で埋めておく (checkSeatAvailability は agent + admin を数えるため、残り枠は 10-8=2)
    for (let i = 0; i < 7; i++) {
      store.users.set(`agt-${i}`, {
        id: `agt-${i}`,
        email: `agt-${i}@example.com`,
        name: `担当 ${i}`,
        passwordHash: 'x',
        role: 'agent',
        tenantId: TENANT_ID,
        createdAt: now,
        updatedAt: now,
      });
    }
    const { createInvitationsBulk } =
      await import('@/features/settings/actions/create-invitations-bulk');

    // 残り枠は 2 名分だが、5 名分の agent 招待を要求する
    await expect(
      createInvitationsBulk(
        makeForm(
          'agent',
          'a@example.com\nb@example.com\nc@example.com\nd@example.com\ne@example.com',
        ),
      ),
    ).rejects.toThrow(/残り 2 枠/);
    // 1 件も発行されていないこと (シート上限を超えて発行される回帰を防ぐ)
    expect([...store.invitations.values()]).toHaveLength(0);
  });

  // /code-review ultra 指摘対応 (2026-07-10): checkSeatAvailability の remaining は
  // limit === -1 (無制限プラン) のとき Math.max(0, -1 - count) = 0 に落ちるバグがあり、
  // Enterprise (無制限シート) テナントの agent 一括招待が常に「残り 0 枠」で拒否されていた。
  // この回帰を検知するテスト。
  it('Enterprise (無制限シート) では残り枠不足を理由に拒否されない', async () => {
    seedTenant('enterprise');
    const { createInvitationsBulk } =
      await import('@/features/settings/actions/create-invitations-bulk');

    const result = await createInvitationsBulk(
      makeForm('agent', 'a@example.com\nb@example.com\nc@example.com'),
    );

    expect(result.results).toHaveLength(3);
    expect(result.results.every((r) => r.ok)).toBe(true);
  });

  // 残り枠内に収まるバッチは全件成功する (拒否が過剰にならないことの確認)
  it('シート残り枠内のバッチは全件成功する', async () => {
    seedTenant('standard');
    const now = new Date();
    // Standard プランの上限 10 名のうち、既存エージェント 7 名 + admin (seedTenant で投入済み) の
    // 計 8 名で埋めておく (checkSeatAvailability は agent + admin を数えるため、残り枠は 10-8=2)
    for (let i = 0; i < 7; i++) {
      store.users.set(`agt-${i}`, {
        id: `agt-${i}`,
        email: `agt-${i}@example.com`,
        name: `担当 ${i}`,
        passwordHash: 'x',
        role: 'agent',
        tenantId: TENANT_ID,
        createdAt: now,
        updatedAt: now,
      });
    }
    const { createInvitationsBulk } =
      await import('@/features/settings/actions/create-invitations-bulk');

    // 残り枠 2 名分ちょうどを要求する
    const result = await createInvitationsBulk(makeForm('agent', 'a@example.com\nb@example.com'));

    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.ok)).toBe(true);
  });

  // バッチのメールアドレス件数がレート制限の残り枠を超える場合は、1 件も発行せずに拒否する
  it('レート制限の残り枠を超えるバッチは1件も発行せず拒否する', async () => {
    seedTenant('standard');
    // /code-review ultra 指摘対応: マジックナンバーを避け、INVITE_RATE_LIMIT_MAX から
    // 「残り 1 件」の状態を導出する (定数が変わってもテストの意図が保たれる)
    const seededCount = INVITE_RATE_LIMIT_MAX - 1;
    // 直近 1 時間に上限 - 1 件発行済みという状態を作る (残り枠は 1 件)
    for (let i = 0; i < seededCount; i++) {
      await repos.invitations.create({
        tokenHash: `hash-${i}`,
        tenantId: TENANT_ID,
        role: 'requester',
        expiresAt: new Date(Date.now() + 60_000),
      });
    }
    const { createInvitationsBulk } =
      await import('@/features/settings/actions/create-invitations-bulk');

    // 残り枠 1 件に対して 2 件のメールアドレスをまとめて送る
    await expect(
      createInvitationsBulk(makeForm('requester', 'a@example.com\nb@example.com')),
    ).rejects.toThrow(/一度に発行できる招待は最大/);
    // 事前に作った件数のまま増えていないこと (今回のバッチは 1 件も発行されない)
    expect([...store.invitations.values()]).toHaveLength(seededCount);
  });

  it('管理者以外は実行できない', async () => {
    seedTenant('standard');
    vi.doMock('@/lib/auth', () => ({
      auth: async () => ({ user: { id: 'u-req-1', role: 'requester', tenantId: TENANT_ID } }),
    }));
    const { createInvitationsBulk } =
      await import('@/features/settings/actions/create-invitations-bulk');

    await expect(createInvitationsBulk(makeForm('requester', 'a@example.com'))).rejects.toThrow();
  });

  // /code-review ultra 指摘対応 (2026-07-13): 行単位の想定外エラーで issueInvitation が
  // Prisma の生エラー (例: 一意制約違反) を投げても、err.message をそのままクライアントへ
  // 返さないこと (§9: 内部エラー文言の非漏洩)。他行は影響を受けず成功すること (部分成功) も確認する。
  it('行単位の想定外エラーは生のエラー文言を返さず安全なメッセージに変換する', async () => {
    seedTenant('standard');
    // 直前のテスト (管理者以外は実行できない) が vi.doMock で auth() を requester に差し替えて
    // おり、vi.doMock は vi.resetModules() を挟んでも解除されない (テスト実行順序に依存しない
    // ようにするため) admin セッションへ明示的に戻す
    vi.doMock('@/lib/auth', () => ({
      auth: async () => ({ user: { id: ADMIN_ID, role: 'admin', tenantId: TENANT_ID } }),
    }));
    // issueInvitation を差し替え、特定の 1 行だけ Prisma 風の生エラーを投げさせる
    vi.doMock('@/features/settings/actions/create-invitation', () => ({
      issueInvitation: async (input: { email?: string }) => {
        if (input.email === 'boom@example.com') {
          // Prisma の一意制約違反エラーを模した生メッセージ (DB スキーマ情報を含む想定)
          throw new Error('Unique constraint failed on the fields: (`tokenHash`)');
        }
        return { url: `https://example.com/invite/${input.email}` };
      },
    }));
    const { createInvitationsBulk } =
      await import('@/features/settings/actions/create-invitations-bulk');

    const result = await createInvitationsBulk(
      makeForm('requester', 'ok@example.com\nboom@example.com'),
    );

    // 正常行は成功する (部分成功)
    const okRow = result.results.find((r) => r.email === 'ok@example.com');
    expect(okRow?.ok).toBe(true);
    // 失敗行は生の Prisma エラー文言を含まず、安全な日本語メッセージに変換されている
    const failedRow = result.results.find((r) => r.email === 'boom@example.com');
    expect(failedRow?.ok).toBe(false);
    expect(failedRow?.error).not.toMatch(/tokenHash|Unique constraint/);
  });
});
