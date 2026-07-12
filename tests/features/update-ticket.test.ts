// Vitest のテスト DSL とモック機能
import { beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ実装の context (store/repos/uow を持つ)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// リポジトリ束 / UoW の型
import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';
// レート制限の履歴をテスト間でクリアする内部用関数
import { __resetRateLimits } from '@/lib/rate-limit';

// 各テスト前に書き換える "可変" な依存。Action import 前に値を入れる必要がある。
let store: Store;
let repos: Repos;
let uow: UnitOfWork;
// セッションのユーザー ID と権限 (テスト中に書き換えてシナリオを変える)
let sessionUserId = 'u-agt-1';
let sessionRole: 'requester' | 'agent' | 'admin' = 'agent';
// テナントスコープ (テストは単一テナント前提で固定)
const TENANT = 'default-tenant';

// src/lib/webhook-fetch.ts (LINE push が内部で使う) は SSRF 対策の DNS 検証用 Dispatcher を使うため
// undici の fetch を直接 import している。vi.stubGlobal('fetch', ...) だけでは差し替わらないため、
// undici の fetch を globalThis.fetch (呼び出し側で差し替える) へ委譲するモックにする
// (tests/features/attachments/post-comment-route.test.ts と同じ回避策)
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: ((...args: Parameters<typeof globalThis.fetch>) =>
      globalThis.fetch(...args)) as unknown as typeof actual.fetch,
  };
});

// @/data モジュールを差し替え。getter で参照することで、テスト中の上書きを反映
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
  get uow() {
    return uow;
  },
}));

// 認証は固定セッションを返すモックに置換 (tenantId も乗せる)
vi.mock('@/lib/auth', () => ({
  auth: async () => ({
    user: { id: sessionUserId, role: sessionRole, tenantId: 'default-tenant' },
  }),
}));

// next/cache の副作用は不要なので spy で潰す
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

// SSE ブロードキャストもテストでは不要
vi.mock('@/lib/sse-subscribers', () => ({
  broadcast: vi.fn(),
}));

// ステータス変更メール (メンバー改善 #3 の回帰固定) の送信を捕捉する。
// 実ファイル (.magic-link-outbox.jsonl) へ書き込む console ドライバを避け、送信内容を配列に貯めて検証する。
// vi.hoisted で先に配列を作り、vi.mock のファクトリから参照できるようにする (巻き上げ順序対策)。
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

// 共通シード: 1 テナント + 1 依頼者 + 2 エージェント + 1 カテゴリ + 1 チケット
async function seed() {
  const now = new Date();
  // まずデフォルトテナントを投入 (User/Category/Ticket の FK 先として必要)
  // 既存テストは Pro 専用ステータス (New / Resolved / Escalated 等) の遷移を検証するため
  // テナント mode は 'pro' で固定 (Lite 専用の挙動は後段の describe ブロックで mode を上書きして検証)
  store.tenants.set('default-tenant', {
    id: 'default-tenant',
    name: 'デフォルト組織',
    mode: 'pro',
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
    createdAt: now,
  });
  // ユーザー雛形
  const users = [
    { id: 'u-req-1', role: 'requester' as const, name: '山田' },
    { id: 'u-agt-1', role: 'agent' as const, name: '佐藤' },
    { id: 'u-agt-2', role: 'agent' as const, name: '鈴木' },
  ];
  // store に直接ユーザーを投入 (テナント所属を付与)
  for (const u of users) {
    store.users.set(u.id, {
      id: u.id,
      email: `${u.id}@example.com`,
      name: u.name,
      passwordHash: 'x',
      role: u.role,
      tenantId: 'default-tenant',
      createdAt: now,
      updatedAt: now,
    });
  }
  // カテゴリも 1 件 (テナント所属)
  store.categories.set('cat-1', {
    id: 'cat-1',
    name: 'アカウント',
    createdAt: now,
    tenantId: 'default-tenant',
  });
  // 検証対象のチケットを依頼者で作成
  const ticket = await repos.tickets.create({
    title: 'VPN がつながらない',
    body: '朝から繋がらないです',
    priority: 'Medium',
    creatorId: 'u-req-1',
    categoryId: 'cat-1',
    tenantId: 'default-tenant',
  });
  return { ticketId: ticket.id };
}

// 各テスト前に依存とレート制限をリセット (テスト間の独立性を確保)
beforeEach(() => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
  uow = ctx.uow;
  // 既定セッションは agent
  sessionUserId = 'u-agt-1';
  sessionRole = 'agent';
  // 動的 import の結果をリセット (mock 設定を反映させるため)
  vi.resetModules();
  // レート制限の履歴をクリア (前テストの呼び出し回数を引きずらない)
  __resetRateLimits();
  // ステータス変更メールの捕捉バッファをクリア (テスト間で送信が混ざらないように)
  sentEmails.length = 0;
});

// ステータス更新アクションの仕様
describe('updateTicketStatus (provider-agnostic)', () => {
  // 正しい遷移なら適用され、履歴も 1 件残ること
  it('applies a valid transition and records history', async () => {
    const { ticketId } = await seed();
    // モックを差し替えてから動的 import (毎回新しいモジュールに)
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    await updateTicketStatus(ticketId, 'Open');

    const t = await repos.tickets.findById(ticketId, TENANT);
    // 反映されている
    expect(t?.status).toBe('Open');
    // 履歴 1 件 (status / New → Open)
    const histories = [...store.histories.values()].filter((h) => h.ticketId === ticketId);
    expect(histories).toHaveLength(1);
    expect(histories[0].field).toBe('status');
    expect(histories[0].oldValue).toBe('New');
    expect(histories[0].newValue).toBe('Open');
  });

  // 不正な遷移では拒否し、履歴も残らないこと (ロールバック)
  it('rejects an invalid transition and rolls back history', async () => {
    const { ticketId } = await seed();
    // 事前に Closed にしておく
    await repos.tickets.updateStatus(ticketId, 'Closed', null, TENANT);
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    // Closed → InProgress は遷移表で禁止されている
    await expect(updateTicketStatus(ticketId, 'InProgress')).rejects.toThrow(
      /変更することはできません/,
    );

    const t = await repos.tickets.findById(ticketId, TENANT);
    // ステータスは変わらない
    expect(t?.status).toBe('Closed');
    // 履歴も残っていない
    expect([...store.histories.values()]).toHaveLength(0);
  });

  // エージェントでない呼び出しは権限エラーで拒否
  it('refuses when caller is not an agent', async () => {
    const { ticketId } = await seed();
    // 依頼者セッションに切り替え
    sessionUserId = 'u-req-1';
    sessionRole = 'requester';
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    await expect(updateTicketStatus(ticketId, 'Open')).rejects.toThrow(/エージェントまたは管理者/);
  });

  // Resolved に遷移すると resolvedAt が現在時刻で記録される
  it('sets resolvedAt when transitioning to Resolved', async () => {
    const { ticketId } = await seed();
    // 事前に Open に
    await repos.tickets.updateStatus(ticketId, 'Open', null, TENANT);
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    // 期待時刻範囲を取るため呼び出し前後の時刻を測る
    const before = Date.now();
    await updateTicketStatus(ticketId, 'Resolved');
    const after = Date.now();

    const t = await repos.tickets.findById(ticketId, TENANT);
    expect(t?.status).toBe('Resolved');
    expect(t?.resolvedAt).toBeInstanceOf(Date);
    const ts = t!.resolvedAt!.getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  // Resolved → Open に戻すと resolvedAt がクリアされる
  it('clears resolvedAt when reopening from Resolved', async () => {
    const { ticketId } = await seed();
    await repos.tickets.updateStatus(ticketId, 'Resolved', new Date(), TENANT);
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    await updateTicketStatus(ticketId, 'Open');

    const t = await repos.tickets.findById(ticketId, TENANT);
    expect(t?.status).toBe('Open');
    expect(t?.resolvedAt).toBeNull();
  });

  // Resolved → Closed (解決済みチケットのクローズ) では resolvedAt を保持する。
  // Pro の完了集合は ['Resolved'] のみで Closed を含まないため、'Closed' を除外しないと
  // クローズ時に resolvedAt が消え、SLA 期限超過表示・解決件数/平均解決時間の集計漏れを招く。
  it('preserves resolvedAt when closing a resolved ticket', async () => {
    const { ticketId } = await seed();
    const resolvedAt = new Date();
    await repos.tickets.updateStatus(ticketId, 'Resolved', resolvedAt, TENANT);
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    await updateTicketStatus(ticketId, 'Closed');

    const t = await repos.tickets.findById(ticketId, TENANT);
    expect(t?.status).toBe('Closed');
    expect(t?.resolvedAt).toBeInstanceOf(Date);
    expect(t?.resolvedAt?.getTime()).toBe(resolvedAt.getTime());
  });

  // Closed → Open (クローズ済みチケットの再オープン) では resolvedAt をクリアする。
  // Resolved→Closed で解決日時を保持するようにしたため、その後の再オープンで消し忘れると
  // 稼働中チケットが SLA 解決済み表示・解決件数へ誤カウントされる。遷移先で判定して両
  // 再オープン経路(Resolved→Open / Closed→Open)を一貫してクリアすることを担保する。
  it('clears resolvedAt when reopening a closed ticket', async () => {
    const { ticketId } = await seed();
    // クローズ済みかつ解決日時ありの状態を用意する
    await repos.tickets.updateStatus(ticketId, 'Closed', new Date(), TENANT);
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    await updateTicketStatus(ticketId, 'Open');

    const t = await repos.tickets.findById(ticketId, TENANT);
    expect(t?.status).toBe('Open');
    expect(t?.resolvedAt).toBeNull();
  });

  // Resolved に関係しない遷移では resolvedAt は変化しない
  it('leaves resolvedAt untouched for transitions not involving Resolved', async () => {
    const { ticketId } = await seed();
    await repos.tickets.updateStatus(ticketId, 'Open', null, TENANT);
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    await updateTicketStatus(ticketId, 'InProgress');

    const t = await repos.tickets.findById(ticketId, TENANT);
    expect(t?.status).toBe('InProgress');
    expect(t?.resolvedAt).toBeNull();
  });
});

// 回帰防止: updateTicketPriority は以前 DB/SSE/メール通知を一切発行しない「完全に無音」の
// アクションだった (updateTicketStatus / updateTicketAssignee 等の兄弟アクションと不整合)。
// ここでは「起票者への通知が作られる」「自己操作では通知しない」「メールが送られる」を検証する。
describe('updateTicketPriority (provider-agnostic)', () => {
  // 正常系: 優先度が更新され、履歴が 1 件残り、起票者以外が操作すると通知とメールが発生する
  it('updates priority, records history, notifies the creator, and sends an email', async () => {
    const { ticketId } = await seed();
    const { updateTicketPriority } = await import('@/features/tickets/actions/update-ticket');

    await updateTicketPriority(ticketId, 'High');

    // 優先度が反映されている
    const t = await repos.tickets.findById(ticketId, TENANT);
    expect(t?.priority).toBe('High');
    // 履歴が 1 件残る (priority / Medium → High)
    const histories = [...store.histories.values()].filter((h) => h.ticketId === ticketId);
    expect(histories).toHaveLength(1);
    expect(histories[0].field).toBe('priority');
    expect(histories[0].oldValue).toBe('Medium');
    expect(histories[0].newValue).toBe('High');
    // 起票者 (u-req-1) 宛に通知が 1 件作られている
    const notifications = [...store.notifications.values()].filter((n) => n.ticketId === ticketId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].userId).toBe('u-req-1');
    expect(notifications[0].type).toBe('priorityChanged');
    expect(notifications[0].message).toContain('高');
    // 起票者宛にメールが送られている
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe('u-req-1@example.com');
  });

  // 変更なし (同じ優先度) なら履歴も通知も作られない (冪等)
  it('does nothing when the priority is unchanged', async () => {
    const { ticketId } = await seed();
    const { updateTicketPriority } = await import('@/features/tickets/actions/update-ticket');

    await updateTicketPriority(ticketId, 'Medium');

    const histories = [...store.histories.values()].filter((h) => h.ticketId === ticketId);
    expect(histories).toHaveLength(0);
    const notifications = [...store.notifications.values()].filter((n) => n.ticketId === ticketId);
    expect(notifications).toHaveLength(0);
    expect(sentEmails).toHaveLength(0);
  });

  // 起票者自身 (エージェントが自分で起票したチケット) が操作した場合は自己通知しない
  // (updateTicketStatus の「自己更新ではメールを送らない」と同じ方針)
  it('does not notify or email the creator when they change the priority themselves', async () => {
    await seed();
    // 起票者が操作者 (u-agt-1) 自身のチケットを作る
    const own = await repos.tickets.create({
      title: '自分で起票した件',
      body: 'x',
      priority: 'Medium',
      creatorId: 'u-agt-1',
      categoryId: 'cat-1',
      tenantId: TENANT,
    });
    const { updateTicketPriority } = await import('@/features/tickets/actions/update-ticket');

    await updateTicketPriority(own.id, 'High');

    const notifications = [...store.notifications.values()].filter((n) => n.ticketId === own.id);
    expect(notifications).toHaveLength(0);
    expect(sentEmails).toHaveLength(0);
  });

  // requester (エージェント以外) は実行できない
  it('refuses when caller is not an agent', async () => {
    const { ticketId } = await seed();
    sessionUserId = 'u-req-1';
    sessionRole = 'requester';
    const { updateTicketPriority } = await import('@/features/tickets/actions/update-ticket');

    await expect(updateTicketPriority(ticketId, 'High')).rejects.toThrow(
      /エージェントまたは管理者/,
    );
  });
});

// Lite モード (mode: 'lite') のテナントから呼び出した場合の遷移検証
// (UI の StatusSelect が見せる選択肢とサーバ側検証が一致することを確認)
describe('updateTicketStatus (Lite mode)', () => {
  // テナント mode を 'lite' に差し替えるヘルパー (seed 後に呼ぶ)
  function setTenantToLite() {
    // 既存の default-tenant エントリを取り出す (seed 済み前提)
    const t = store.tenants.get('default-tenant');
    // 念のため見つからなければ assert (テスト前提崩壊の早期検知)
    if (!t) throw new Error('seed missing default-tenant');
    // mode フィールドだけ 'lite' に書き換えて再格納
    store.tenants.set('default-tenant', { ...t, mode: 'lite' });
  }

  // Lite: 対応中 → 未対応 (InProgress → Open) は Lite 遷移表で許可されているので成功すること
  it('allows InProgress to Open in Lite mode (Pro table rejects this)', async () => {
    const { ticketId } = await seed();
    // テナントを Lite に切り替えてから事前ステータスを InProgress に
    setTenantToLite();
    // 事前準備として InProgress 状態にしておく (Pro 表でも New→InProgress は許可される)
    await repos.tickets.updateStatus(ticketId, 'InProgress', null, TENANT);
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    // Lite では InProgress → Open は許可されるので成功する
    await updateTicketStatus(ticketId, 'Open');

    // 反映確認
    const t = await repos.tickets.findById(ticketId, TENANT);
    expect(t?.status).toBe('Open');
  });

  // Lite: 未対応 → エスカレーション (Open → Escalated) は Lite 遷移表に Escalated が無いため失敗すること
  it('rejects Open to Escalated in Lite mode (Pro table would allow this)', async () => {
    const { ticketId } = await seed();
    setTenantToLite();
    // 事前準備として Open 状態にしておく
    await repos.tickets.updateStatus(ticketId, 'Open', null, TENANT);
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    // Lite では Escalated は非 Lite ステータスなので、ターゲット制限ガードに弾かれる
    // ("Lite モードでは「Escalated」へは変更できません" メッセージで reject)
    await expect(updateTicketStatus(ticketId, 'Escalated')).rejects.toThrow(/Lite モードでは/);

    // ステータスは Open のまま (ロールバック)
    const t = await repos.tickets.findById(ticketId, TENANT);
    expect(t?.status).toBe('Open');
  });

  // Lite: 対応中 → 完了 (InProgress → Closed) で resolvedAt が現在時刻にセットされること
  // (Lite UI の「完了」は Closed なので SLA が 'ok' 扱いになるための前提)
  it('sets resolvedAt when transitioning to Closed in Lite mode', async () => {
    const { ticketId } = await seed();
    setTenantToLite();
    // 事前準備として InProgress 状態にする (resolvedAt は null のまま)
    await repos.tickets.updateStatus(ticketId, 'InProgress', null, TENANT);
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    // 呼び出し前後の時刻を測って resolvedAt の妥当性を検証
    const before = Date.now();
    await updateTicketStatus(ticketId, 'Closed');
    const after = Date.now();

    // 反映確認
    const t = await repos.tickets.findById(ticketId, TENANT);
    expect(t?.status).toBe('Closed');
    // resolvedAt が Date でセットされている
    expect(t?.resolvedAt).toBeInstanceOf(Date);
    // 計測した範囲内に収まる
    const ts = t!.resolvedAt!.getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  // Lite: 完了 → 未対応 (Closed → Open) で resolvedAt がクリアされること (再オープン時の戻し)
  it('clears resolvedAt when reopening from Closed in Lite mode', async () => {
    const { ticketId } = await seed();
    setTenantToLite();
    // 事前準備として Closed + resolvedAt セット済みの状態にする
    await repos.tickets.updateStatus(ticketId, 'Closed', new Date(), TENANT);
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    // Closed → Open は Lite 遷移表で許可されているので成功する
    await updateTicketStatus(ticketId, 'Open');

    // 反映と resolvedAt クリアを確認
    const t = await repos.tickets.findById(ticketId, TENANT);
    expect(t?.status).toBe('Open');
    expect(t?.resolvedAt).toBeNull();
  });

  // Lite: 旧 Pro データの Resolved → Open (Pro 表フォールバックで許可) でも resolvedAt がクリアされること
  // (Lite では Resolved/Closed 両方を completionStatuses として扱う設計の検証)
  it('clears resolvedAt when reopening from legacy Resolved in Lite mode', async () => {
    const { ticketId } = await seed();
    setTenantToLite();
    // 事前準備として Resolved + resolvedAt セット済みの状態にする (旧 Pro データを想定)
    await repos.tickets.updateStatus(ticketId, 'Resolved', new Date(), TENANT);
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    // Lite モードでも Resolved は LiteStatus に含まれないため Pro 遷移表へフォールバック、
    // Pro['Resolved'] には 'Open' が含まれるので遷移は許可される
    await updateTicketStatus(ticketId, 'Open');

    // 反映と resolvedAt クリアを確認 (SLA 表示が「解決済み残存」にならないことの担保)
    const t = await repos.tickets.findById(ticketId, TENANT);
    expect(t?.status).toBe('Open');
    expect(t?.resolvedAt).toBeNull();
  });

  // Lite: 旧 Pro データの Resolved → Closed (Pro 表フォールバックで許可) では resolvedAt が新しい時刻で更新されること
  // (両方とも completionStatuses に含まれるため、終端状態間の移動として今の時刻で再記録する)
  it('updates resolvedAt when moving from legacy Resolved to Closed in Lite mode', async () => {
    const { ticketId } = await seed();
    setTenantToLite();
    // 古い resolvedAt (10 分前) を持つ Resolved の状態を作る
    const oldResolvedAt = new Date(Date.now() - 10 * 60 * 1000);
    await repos.tickets.updateStatus(ticketId, 'Resolved', oldResolvedAt, TENANT);
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    // 呼び出し前後の時刻を測って resolvedAt の妥当性を検証
    const before = Date.now();
    // Pro 表フォールバックで Resolved → Closed が許可される
    await updateTicketStatus(ticketId, 'Closed');
    const after = Date.now();

    // 反映確認
    const t = await repos.tickets.findById(ticketId, TENANT);
    expect(t?.status).toBe('Closed');
    // resolvedAt が新しい時刻で上書きされている (古い 10 分前の値ではない)
    expect(t?.resolvedAt).toBeInstanceOf(Date);
    const ts = t!.resolvedAt!.getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
    // 古いタイムスタンプとは異なることも明示的に確認
    expect(ts).toBeGreaterThan(oldResolvedAt.getTime());
  });

  // Lite: 旧 Pro データの Resolved → WaitingForUser (Pro 表では許可) は新ターゲット制限で弾かれること
  // (off-ramp は Lite 3 値 (Open / InProgress / Closed) へのみ許可するのが Pivot plan §3.1 / §5.2 の趣旨)
  it('rejects legacy Resolved to WaitingForUser in Lite mode (target restriction)', async () => {
    const { ticketId } = await seed();
    setTenantToLite();
    // 事前準備として Resolved + resolvedAt セット済みの状態にする (旧 Pro データを想定)
    await repos.tickets.updateStatus(ticketId, 'Resolved', new Date(), TENANT);
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    // WaitingForUser は Lite 3 値に含まれないので、ターゲット制限ガードで弾かれる
    await expect(updateTicketStatus(ticketId, 'WaitingForUser')).rejects.toThrow(/Lite モードでは/);

    // ステータスは Resolved のまま (ロールバック)
    const t = await repos.tickets.findById(ticketId, TENANT);
    expect(t?.status).toBe('Resolved');
  });
});

// 担当者更新アクションの仕様
describe('updateTicketAssignee (provider-agnostic)', () => {
  // 正常系: 担当者を割り当てると履歴と通知が作られる
  it('assigns an agent, records history, creates a notification', async () => {
    const { ticketId } = await seed();
    const { updateTicketAssignee } = await import('@/features/tickets/actions/update-ticket');

    await updateTicketAssignee(ticketId, 'u-agt-2');

    const t = await repos.tickets.findById(ticketId, TENANT);
    expect(t?.assigneeId).toBe('u-agt-2');

    // 履歴 1 件 (assignee / null → 鈴木)
    const histories = [...store.histories.values()];
    expect(histories).toHaveLength(1);
    expect(histories[0].field).toBe('assignee');
    expect(histories[0].newValue).toBe('鈴木');

    // 担当者本人にだけ assigned 通知が届く
    const notifications = [...store.notifications.values()];
    expect(notifications).toHaveLength(1);
    expect(notifications[0].userId).toBe('u-agt-2');
    expect(notifications[0].type).toBe('assigned');
  });

  // 依頼者を担当者にしようとすると拒否される
  it('refuses to assign a requester', async () => {
    const { ticketId } = await seed();
    const { updateTicketAssignee } = await import('@/features/tickets/actions/update-ticket');

    await expect(updateTicketAssignee(ticketId, 'u-req-1')).rejects.toThrow(
      /指定された担当者を設定できません/,
    );
    expect([...store.histories.values()]).toHaveLength(0);
    expect([...store.notifications.values()]).toHaveLength(0);
  });

  // 存在しないユーザーを指定しても同じメッセージで拒否 (内部理由は漏らさない)
  it('refuses to assign a non-existent user with the same message', async () => {
    const { ticketId } = await seed();
    const { updateTicketAssignee } = await import('@/features/tickets/actions/update-ticket');

    await expect(updateTicketAssignee(ticketId, 'u-missing')).rejects.toThrow(
      /指定された担当者を設定できません/,
    );
    expect([...store.histories.values()]).toHaveLength(0);
    expect([...store.notifications.values()]).toHaveLength(0);
  });

  // 別テナント所属のエージェントを担当者にしようとしても同じメッセージで拒否 (cross-tenant 遮断)
  it('refuses to assign an agent who belongs to a different tenant', async () => {
    const { ticketId } = await seed();
    // テナント B 側にエージェントを 1 名作る (ロールは agent、テナントだけ違う)
    const now = new Date();
    store.tenants.set('tenant-b', {
      id: 'tenant-b',
      name: '別組織',
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
      createdAt: now,
    });
    // 別テナントのエージェントを store に直接投入
    store.users.set('u-b-agt-1', {
      id: 'u-b-agt-1',
      email: 'u-b-agt-1@example.com',
      name: '別組織の担当',
      passwordHash: 'x',
      role: 'agent',
      tenantId: 'tenant-b', // 既定テナントとは別
      createdAt: now,
      updatedAt: now,
    });
    const { updateTicketAssignee } = await import('@/features/tickets/actions/update-ticket');

    // 別テナントのエージェント ID を渡すと一般的な拒否メッセージが返る (内部理由は漏らさない)
    await expect(updateTicketAssignee(ticketId, 'u-b-agt-1')).rejects.toThrow(
      /指定された担当者を設定できません/,
    );
    // 履歴や通知が一切作られていないこと (拒否時は副作用なし)
    expect([...store.histories.values()]).toHaveLength(0);
    expect([...store.notifications.values()]).toHaveLength(0);
    // 当該チケットの担当者欄も書き換わっていない
    const t = await repos.tickets.findById(ticketId, TENANT);
    expect(t?.assigneeId).toBeNull();
  });
});

// 注: addComment Server Action のテストは POST /api/tickets/[id]/comments の Route Handler テスト
// (tests/features/attachments/post-comment-route.test.ts) に移行済み。

// エスカレーションアクションの仕様
describe('escalateTicket (provider-agnostic)', () => {
  // 状態を Escalated にし、履歴を残し、全エージェントに通知が届くこと
  it('marks escalated, records history, and notifies every agent', async () => {
    const { ticketId } = await seed();
    // Open 状態からエスカレーション (遷移表で許可されている)
    await repos.tickets.updateStatus(ticketId, 'Open', null, TENANT);
    const { escalateTicket } = await import('@/features/tickets/actions/update-ticket');

    // 前後空白を含めて渡し、保存時にトリムされていることも確認
    await escalateTicket(ticketId, '  対応困難  ');

    const t = await repos.tickets.findById(ticketId, TENANT);
    expect(t?.status).toBe('Escalated');
    expect(t?.escalationReason).toBe('対応困難');
    expect(t?.escalatedAt).toBeInstanceOf(Date);

    // 通知は 2 エージェント全員に届く
    const notifications = [...store.notifications.values()];
    expect(notifications).toHaveLength(2);
    expect(new Set(notifications.map((n) => n.userId))).toEqual(new Set(['u-agt-1', 'u-agt-2']));
    for (const n of notifications) {
      expect(n.type).toBe('escalated');
      expect(n.ticketId).toBe(ticketId);
    }
  });

  // Lite モードではエスカレーション機能そのものが提供されないこと (Pivot plan §3.1 / §5.2)
  it('rejects escalation in Lite mode', async () => {
    const { ticketId } = await seed();
    // テナントを Lite に切り替え (UI ではボタンが出ないが、Server Action 直叩きの防御を検証)
    // setTenantToLite は別 describe スコープにあるためインラインで mode を書き換える
    const tenant = store.tenants.get('default-tenant');
    if (!tenant) throw new Error('seed missing default-tenant');
    store.tenants.set('default-tenant', { ...tenant, mode: 'lite' });
    // 既存ステータスを Open にしておく (Pro なら Open → Escalated が通る遷移)
    await repos.tickets.updateStatus(ticketId, 'Open', null, TENANT);
    const { escalateTicket } = await import('@/features/tickets/actions/update-ticket');

    // Lite ガードによる拒否 (エラー文言で確認)
    await expect(escalateTicket(ticketId, '緊急対応必要')).rejects.toThrow(/Lite モードでは/);

    // 副作用がないこと: ステータス維持・理由・日時はすべて未書き込み
    const t = await repos.tickets.findById(ticketId, TENANT);
    expect(t?.status).toBe('Open');
    expect(t?.escalationReason).toBeNull();
    expect(t?.escalatedAt).toBeNull();
    // 通知も作られていない
    expect([...store.notifications.values()]).toHaveLength(0);
  });
});

// メンバー改善 #3「statusChanged 通知の宛先確認」の回帰固定。
// 解決通知などのステータス変更が依頼者へメール送信される (= 体験が完結する) ことを固定し、
// 自己更新では送らない・エスカレーションは依頼者へメールしない (担当者通知のみ) ことも明示する。
describe('updateTicketStatus メール通知 (メンバー改善 #3 回帰)', () => {
  // ステータス変更時、操作者以外の起票者 (依頼者) へ状況変更メールが 1 通届く
  it('ステータス変更を依頼者へメール送信する', async () => {
    const { ticketId } = await seed();
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    // 担当者 (u-agt-1) が依頼者 (u-req-1) のチケットを New → Open に変更する
    await updateTicketStatus(ticketId, 'Open');

    // 依頼者宛に 1 通だけ送られる
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe('u-req-1@example.com');
    // 件名はステータス変更メール (「状況が…変わりました」) で、対象の件名を含む
    expect(sentEmails[0].subject).toContain('状況');
    expect(sentEmails[0].subject).toContain('VPN がつながらない');
  });

  // 解決 (Resolved) への変更でも依頼者へメールが届く (「解決しました」が依頼者に伝わる)
  it('解決ステータスへの変更も依頼者へメール送信する', async () => {
    const { ticketId } = await seed();
    // 事前に Open にしてから Resolved にする (New → Resolved は遷移表で許可されないため)
    await repos.tickets.updateStatus(ticketId, 'Open', null, TENANT);
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    await updateTicketStatus(ticketId, 'Resolved');

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe('u-req-1@example.com');
  });

  // 自己更新 (操作者 = 起票者) では自分宛メールを送らない
  it('自己更新ではメールを送らない', async () => {
    await seed();
    // 起票者が操作者 (u-agt-1) 自身のチケットを作る
    const own = await repos.tickets.create({
      title: '自分で起票した件',
      body: 'x',
      priority: 'Medium',
      creatorId: 'u-agt-1',
      categoryId: 'cat-1',
      tenantId: TENANT,
    });
    const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');

    await updateTicketStatus(own.id, 'Open');

    // 自己更新なのでメールは送らない (無駄な自分宛通知を避ける)
    expect(sentEmails).toHaveLength(0);
  });

  // エスカレーションは依頼者へメールせず、担当者へのアプリ内通知のみとする (内部トリアージ操作)。
  // 「解決通知は届く / エスカレーションは内部通知のみ」という現行の意図を回帰として固定する。
  it('エスカレーションは依頼者へメールしない (担当者へのメール通知のみ)', async () => {
    const { ticketId } = await seed();
    await repos.tickets.updateStatus(ticketId, 'Open', null, TENANT);
    const { escalateTicket } = await import('@/features/tickets/actions/update-ticket');

    // 操作者は u-agt-1 (デフォルトの sessionUserId)
    await escalateTicket(ticketId, '対応困難');

    // 依頼者 (u-req-1) 宛メールは送られない (エスカレーションは社内向け)
    expect(sentEmails.some((m) => m.to === 'u-req-1@example.com')).toBe(false);
    // 操作者本人 (u-agt-1) は自分の操作を知っているため自分宛には送らない。
    // 他の担当者 (u-agt-2) には Phase 2 メール通知テンプレートとしてエスカレーションメールが 1 通届く
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe('u-agt-2@example.com');
    expect(sentEmails[0].subject).toContain('エスカレーション');
    // 担当者には escalated のアプリ内通知が届く (全 2 エージェント)
    const notifications = [...store.notifications.values()];
    expect(notifications).toHaveLength(2);
    expect(notifications.every((n) => n.type === 'escalated')).toBe(true);
  });
});

// §5.4 フォローアップ: これまで LINE push はコメント返信 (POST /api/tickets/[id]/comments) にしか
// 実装されておらず、ステータス変更は依頼者が LINE 連携済みでもメールでしか届かなかった。
// tests/features/attachments/post-comment-route.test.ts の LINE push テストと同じ観点
// (連携済みなら送る / プランが許可しなければ送らない) をステータス変更でも固定する。
describe('updateTicketStatus LINE 通知 (§5.4 フォローアップ)', () => {
  // LINE 連携済み (lineUserId 設定済み + Pro プラン + TenantLineConfig あり) の依頼者には
  // メールに加えて LINE Messaging API への push も行われる
  it('LINE 連携済みの依頼者へステータス変更を push する', async () => {
    const { ticketId } = await seed();
    // LINE 連携は Pro/Enterprise 限定機能 (§6.1 料金プラン) なので、seed() 既定の free から昇格させる
    const tenant = store.tenants.get(TENANT)!;
    store.tenants.set(TENANT, { ...tenant, subscriptionPlan: 'pro' as const });
    // 依頼者を LINE 連携済みにする
    const requester = store.users.get('u-req-1')!;
    const lineUserId = `U${'a'.repeat(32)}`;
    store.users.set('u-req-1', { ...requester, lineUserId });
    // テナントの LINE 連携設定 (アクセストークン) をシードする
    const now = new Date();
    store.lineConfigs.set('line_cfg_test', {
      id: 'line_cfg_test',
      tenantId: TENANT,
      channelSecret: 'irrelevant-for-push',
      channelAccessToken: 'test-access-token',
      botUserId: `U${'b'.repeat(32)}`,
      createdAt: now,
      updatedAt: now,
    });

    // fetch をモックして実際の外部送信は行わない
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      type: 'basic',
      text: () => Promise.resolve('{}'),
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');
      await updateTicketStatus(ticketId, 'Open');

      // LINE Messaging API へ 1 回 push されている
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.line.me/v2/bot/message/push');
      const body = JSON.parse(init.body);
      expect(body.to).toBe(lineUserId);
      // メールと同じくステータスラベルの日本語変換 (Pro モードなので New→Open は「新規」→「オープン」) を含む
      expect(body.messages[0].text).toContain('新規 → オープン');
    } finally {
      // 他テストへ影響しないよう fetch のスタブを必ず元に戻す
      vi.unstubAllGlobals();
    }
  });

  // 回帰防止: LINE 連携は Pro/Enterprise 限定機能。TenantLineConfig 行が残っていても、
  // テナントがダウングレード (または未アップグレード) であれば push しないこと
  it('プランが LINE 連携を許可しない場合は push しない', async () => {
    const { ticketId } = await seed();
    // seed() 既定の free プランのまま (LINE 連携を許可しないプラン)
    const requester = store.users.get('u-req-1')!;
    const lineUserId = `U${'a'.repeat(32)}`;
    store.users.set('u-req-1', { ...requester, lineUserId });
    // テナントの LINE 連携設定自体は残っている状態を再現する (ダウングレード後も行は削除されない)
    const now = new Date();
    store.lineConfigs.set('line_cfg_test_free', {
      id: 'line_cfg_test_free',
      tenantId: TENANT,
      channelSecret: 'irrelevant-for-push',
      channelAccessToken: 'test-access-token',
      botUserId: `U${'c'.repeat(32)}`,
      createdAt: now,
      updatedAt: now,
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      type: 'basic',
      text: () => Promise.resolve('{}'),
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const { updateTicketStatus } = await import('@/features/tickets/actions/update-ticket');
      await updateTicketStatus(ticketId, 'Open');

      // Free プランでは LINE push が送られない (メールは通常通り届く)
      expect(fetchMock).not.toHaveBeenCalled();
      expect(sentEmails).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// §5.4.2 フォローアップ (2026-07-10): §5.4.1 はステータス変更のみに LINE 通知を追加し、
// 優先度変更・担当者アサインへの拡張は明示的にスコープ外としていた。優先度変更も依頼者向けの
// 主要イベントであるため、同じ判定順序・文面規約で LINE 通知を追加した回帰防止テスト。
describe('updateTicketPriority LINE 通知 (§5.4.2 フォローアップ)', () => {
  // LINE 連携済み (lineUserId 設定済み + Pro プラン + TenantLineConfig あり) の依頼者には
  // メールに加えて LINE Messaging API への push も行われる
  it('LINE 連携済みの依頼者へ優先度変更を push する', async () => {
    const { ticketId } = await seed();
    // LINE 連携は Pro/Enterprise 限定機能 (§6.1 料金プラン) なので、seed() 既定の free から昇格させる
    const tenant = store.tenants.get(TENANT)!;
    store.tenants.set(TENANT, { ...tenant, subscriptionPlan: 'pro' as const });
    // 依頼者を LINE 連携済みにする
    const requester = store.users.get('u-req-1')!;
    const lineUserId = `U${'a'.repeat(32)}`;
    store.users.set('u-req-1', { ...requester, lineUserId });
    // テナントの LINE 連携設定 (アクセストークン) をシードする
    const now = new Date();
    store.lineConfigs.set('line_cfg_priority_test', {
      id: 'line_cfg_priority_test',
      tenantId: TENANT,
      channelSecret: 'irrelevant-for-push',
      channelAccessToken: 'test-access-token',
      botUserId: `U${'d'.repeat(32)}`,
      createdAt: now,
      updatedAt: now,
    });

    // fetch をモックして実際の外部送信は行わない
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      type: 'basic',
      text: () => Promise.resolve('{}'),
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const { updateTicketPriority } = await import('@/features/tickets/actions/update-ticket');
      await updateTicketPriority(ticketId, 'High');

      // LINE Messaging API へ 1 回 push されている
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.line.me/v2/bot/message/push');
      const body = JSON.parse(init.body);
      expect(body.to).toBe(lineUserId);
      // メールと同じく優先度ラベルの日本語変換 (Medium→High は「中」→「高」) を含む
      expect(body.messages[0].text).toContain('中 → 高');
    } finally {
      // 他テストへ影響しないよう fetch のスタブを必ず元に戻す
      vi.unstubAllGlobals();
    }
  });

  // 回帰防止: LINE 連携は Pro/Enterprise 限定機能。TenantLineConfig 行が残っていても、
  // テナントがダウングレード (または未アップグレード) であれば push しないこと
  it('プランが LINE 連携を許可しない場合は push しない', async () => {
    const { ticketId } = await seed();
    // seed() 既定の free プランのまま (LINE 連携を許可しないプラン)
    const requester = store.users.get('u-req-1')!;
    const lineUserId = `U${'a'.repeat(32)}`;
    store.users.set('u-req-1', { ...requester, lineUserId });
    // テナントの LINE 連携設定自体は残っている状態を再現する (ダウングレード後も行は削除されない)
    const now = new Date();
    store.lineConfigs.set('line_cfg_priority_test_free', {
      id: 'line_cfg_priority_test_free',
      tenantId: TENANT,
      channelSecret: 'irrelevant-for-push',
      channelAccessToken: 'test-access-token',
      botUserId: `U${'e'.repeat(32)}`,
      createdAt: now,
      updatedAt: now,
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      type: 'basic',
      text: () => Promise.resolve('{}'),
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const { updateTicketPriority } = await import('@/features/tickets/actions/update-ticket');
      await updateTicketPriority(ticketId, 'High');

      // Free プランでは LINE push が送られない (メールは通常通り届く)
      expect(fetchMock).not.toHaveBeenCalled();
      expect(sentEmails).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
