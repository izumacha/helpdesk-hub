// POST /api/internal/sla-reminders (issue-backlog #20 SLA 期限接近リマインダー) のテスト。
// 共有シークレット認証 (未設定/欠落/不一致)・警告帯判定・冪等化・
// 1件の失敗が他のチケットを止めないことをメモリアダプタで検証する。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// レート制限バケットをテスト間で初期化するヘルパー
import { __resetRateLimits } from '@/lib/rate-limit';
// 「上限までは429にならず、上限+1回目で429になる」の共通アサーションヘルパー
import { expectRateLimitTripsAfter } from './sso-rate-limit-assertions';
// メモリ実装の context (store/repos)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// リポジトリ束の型
import type { Repos } from '@/data/ports/unit-of-work';

const CRON_SECRET = 'test-sla-cron-secret-value';
const HOUR_MS = 60 * 60 * 1000;

// 各テストで差し替える可変な依存 (Route import 前に値を入れる)
let store: Store;
let repos: Repos;

// @/data を差し替え (getter で beforeEach の上書きを反映)
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

// 未読カウントの SSE 再配信は本テストの関心事ではないため、呼び出しの記録だけ行うモックに置換する
// (import-tickets.test.ts と同じ方式。sse-subscribers 経由の notificationBroadcaster は
// @/data のモックに含まれておらず、実装をそのまま呼ぶとそこで例外になるため必須)
const { broadcastCalls } = vi.hoisted(() => ({
  broadcastCalls: [] as Array<{ userId: string; tenantId: string }>,
}));
vi.mock('@/features/notifications/notify', () => ({
  broadcastUnreadCount: vi.fn(async (userId: string, tenantId: string) => {
    broadcastCalls.push({ userId, tenantId });
  }),
}));

// 動的 import: 上のモック設定が反映された後で対象を読み込む
async function loadRoute() {
  const mod = await import('@/app/api/internal/sla-reminders/route');
  return mod.POST;
}

// 認証済みリクエストを組み立てるヘルパー (token 省略時は正しいシークレットを使う)
function makeRequest(token?: string | null): Request {
  const headers = new Headers();
  if (token !== null) {
    headers.set('authorization', `Bearer ${token ?? CRON_SECRET}`);
  }
  return new Request('http://localhost/api/internal/sla-reminders', {
    method: 'POST',
    headers,
  });
}

// 指定条件のチケットを 1 件シードする (差分のみ overrides で上書き)
function seedTicket(
  id: string,
  overrides: {
    resolutionDueAt: Date | null;
    resolvedAt?: Date | null;
    assigneeId?: string | null;
    status?: 'Open' | 'InProgress' | 'Resolved' | 'Closed';
    slaReminderNotifiedForDueAt?: Date | null;
    tenantId?: string;
  },
) {
  const now = new Date();
  store.tickets.set(id, {
    id,
    title: `チケット${id}`,
    body: '本文',
    status: overrides.status ?? 'Open',
    priority: 'Medium',
    createdAt: now,
    updatedAt: now,
    firstResponseDueAt: null,
    resolutionDueAt: overrides.resolutionDueAt,
    firstRespondedAt: null,
    resolvedAt: overrides.resolvedAt ?? null,
    escalatedAt: null,
    escalationReason: null,
    slaReminderNotifiedForDueAt: overrides.slaReminderNotifiedForDueAt ?? null,
    creatorId: 'creator-1',
    // `??` だと明示的な `null` (未アサインを表す意図) まで既定値 'agent-1' に丸めてしまうため、
    // 「overrides に含まれているか」で「未指定 (既定値を使う)」と「明示的に null」を区別する
    assigneeId: 'assigneeId' in overrides ? (overrides.assigneeId as string | null) : 'agent-1',
    categoryId: null,
    locationId: null,
    tenantId: overrides.tenantId ?? 'tenant-1',
  });
}

describe('POST /api/internal/sla-reminders', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
    broadcastCalls.length = 0;
    vi.stubEnv('SLA_REMINDER_CRON_SECRET', CRON_SECRET);
    // このファイルは 1 テストあたり複数回 POST するため、レート制限バケットをリセットする
    // (リセットしないと後続のテストが前のテストのカウントを引き継いで意図せず 429 になる)
    __resetRateLimits();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // fail-closed: シークレット未設定なら処理せず 500 を返す
  it('シークレット未設定時は処理せず500を返す', async () => {
    vi.stubEnv('SLA_REMINDER_CRON_SECRET', '');
    seedTicket('t1', { resolutionDueAt: new Date(Date.now() + 12 * HOUR_MS) });
    const POST = await loadRoute();
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
    expect(store.notifications.size).toBe(0);
  });

  // Authorization ヘッダが無ければ 401
  it('Authorizationヘッダが無ければ401を返す', async () => {
    const POST = await loadRoute();
    const res = await POST(makeRequest(null));
    expect(res.status).toBe(401);
  });

  // トークンが不一致なら 401
  it('トークン不一致は401を返す', async () => {
    const POST = await loadRoute();
    const res = await POST(makeRequest('wrong-token'));
    expect(res.status).toBe(401);
  });

  // 警告帯 (残り24時間以内・未超過) の未解決チケットには通知する
  it('警告帯のチケットに通知を送る', async () => {
    seedTicket('t1', { resolutionDueAt: new Date(Date.now() + 12 * HOUR_MS) });
    const POST = await loadRoute();
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.remindersSent).toBe(1);
    const notifications = [...store.notifications.values()];
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe('slaDueSoon');
    expect(notifications[0].userId).toBe('agent-1');
    expect(notifications[0].ticketId).toBe('t1');
    expect(broadcastCalls).toEqual([{ userId: 'agent-1', tenantId: 'tenant-1' }]);
  });

  // まだ警告帯に入っていなければ送信しない
  it('警告帯に入っていなければ送信しない', async () => {
    seedTicket('t1', { resolutionDueAt: new Date(Date.now() + 48 * HOUR_MS) });
    const POST = await loadRoute();
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.remindersSent).toBe(0);
    expect(store.notifications.size).toBe(0);
  });

  // 既に期限超過なら送信しない (超過は一覧・詳細のバッジで既に警告済みのため対象外)
  it('期限超過のチケットには送信しない', async () => {
    seedTicket('t1', { resolutionDueAt: new Date(Date.now() - HOUR_MS) });
    const POST = await loadRoute();
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.remindersSent).toBe(0);
  });

  // 担当者未アサインなら送信しない
  it('担当者未アサインのチケットには送信しない', async () => {
    seedTicket('t1', { resolutionDueAt: new Date(Date.now() + 12 * HOUR_MS), assigneeId: null });
    const POST = await loadRoute();
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.remindersSent).toBe(0);
  });

  // 解決済みなら送信しない
  it('解決済みのチケットには送信しない', async () => {
    seedTicket('t1', {
      resolutionDueAt: new Date(Date.now() + 12 * HOUR_MS),
      resolvedAt: new Date(),
      status: 'Resolved',
    });
    const POST = await loadRoute();
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.remindersSent).toBe(0);
  });

  // 既に同じ期限に対して通知済みなら再送しない (workflow_dispatch の手動再実行や
  // 同一時間内の複数回実行での二重送信防止)
  it('同じ期限に既に通知済みなら再送しない', async () => {
    const dueAt = new Date(Date.now() + 12 * HOUR_MS);
    seedTicket('t1', { resolutionDueAt: dueAt, slaReminderNotifiedForDueAt: dueAt });
    const POST = await loadRoute();
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.remindersSent).toBe(0);
    expect(store.notifications.size).toBe(0);
  });

  // 送信成功後は slaReminderNotifiedForDueAt が resolutionDueAt と同じ値で永続化されること
  it('送信成功後に冪等化フラグを永続化する', async () => {
    const dueAt = new Date(Date.now() + 12 * HOUR_MS);
    seedTicket('t1', { resolutionDueAt: dueAt });
    const POST = await loadRoute();
    await POST(makeRequest());
    expect(store.tickets.get('t1')?.slaReminderNotifiedForDueAt?.getTime()).toBe(dueAt.getTime());
  });

  // 優先度変更等で期限が前と変わっていれば、以前の通知済みフラグがあっても再送する (取りこぼし防止)
  it('期限が変わっていれば再送する', async () => {
    const oldDueAt = new Date(Date.now() + 48 * HOUR_MS);
    const newDueAt = new Date(Date.now() + 12 * HOUR_MS);
    seedTicket('t1', { resolutionDueAt: newDueAt, slaReminderNotifiedForDueAt: oldDueAt });
    const POST = await loadRoute();
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.remindersSent).toBe(1);
  });

  // 1 件の通知作成失敗が他のチケットへの通知を止めない
  it('1件の通知作成失敗が他のチケットの送信を妨げない', async () => {
    seedTicket('t-fail', { resolutionDueAt: new Date(Date.now() + 12 * HOUR_MS) });
    seedTicket('t-ok', { resolutionDueAt: new Date(Date.now() + 12 * HOUR_MS) });
    // t-fail への通知作成だけ失敗させる
    const originalCreate = repos.notifications.create.bind(repos.notifications);
    repos.notifications.create = async (input) => {
      if (input.ticketId === 't-fail') throw new Error('DB 接続エラー (テスト用)');
      return originalCreate(input);
    };
    const POST = await loadRoute();
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.remindersSent).toBe(1);
    const notifications = [...store.notifications.values()];
    expect(notifications.map((n) => n.ticketId)).toEqual(['t-ok']);
    // 失敗したチケットは冪等化フラグを永続化しない (次回実行時に再試行できるようにする)
    expect(store.tickets.get('t-fail')?.slaReminderNotifiedForDueAt).toBeNull();
  });

  // 監査で発見したギャップ対応: 共有シークレットのみで守られたこの経路にレート制限が無いと、
  // シークレット漏洩時に無制限に叩けてしまう。固定キーのレート制限 (60秒5回) を検証する
  describe('レート制限', () => {
    // 上限 (5回/60秒) を超えると、認証結果 (トークン不一致) より前に429を返す
    it('固定キーのレート制限を超えると429を返す', async () => {
      const POST = await loadRoute();
      await expectRateLimitTripsAfter(() => POST(makeRequest('wrong-token')), 5);
    });
  });
});
