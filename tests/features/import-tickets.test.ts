// importTickets Server Action の単体テスト。
// CSV パース・バリデーション・テナントスコープ・RBAC・通知連携・CSV インジェクション方針を検証する。
// 外部 DB・SSE・メール送信は一切行わず、メモリ Adapter とモックで完結する。

// Vitest の DSL とモック
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ Adapter の context (store/repos)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// リポジトリ束の型
import type { Repos } from '@/data/ports/unit-of-work';
// レート制限をテスト間でクリアする内部用関数
import { __resetRateLimits } from '@/lib/rate-limit';

// 外部通知 (Slack/Teams/Chatwork) テスト用の Slack Webhook URL (実際には送信されない)
const SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/T000/B000/xxx';

// src/lib/webhook-fetch.ts は SSRF 対策の DNS 検証用 Dispatcher (Agent) を使うため
// undici の fetch を直接 import している。vi.stubGlobal('fetch', ...) だけでは差し替わらない
// ため、undici の fetch を globalThis.fetch へ委譲するモックにする (他テストへは影響しない)
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: ((...args: Parameters<typeof globalThis.fetch>) =>
      globalThis.fetch(...args)) as unknown as typeof actual.fetch,
  };
});

// 各テストで書き換える「可変な依存」 (Action import 前に値を入れる必要がある)
let store: Store;
let repos: Repos;
// セッションの権限とユーザー ID (テスト中に書き換えてシナリオを変える)
let sessionUserId = 'u-agt-1';
let sessionRole: 'requester' | 'agent' | 'admin' = 'agent';
// テナント識別子 (全テストで固定)
const TENANT = 'default-tenant';

// broadcastUnreadCountToMany の呼び出しを捕捉するモック関数。
// vi.hoisted で先に作成してから vi.mock 内で参照できるようにする (巻き上げ順序対策)。
const { broadcastMock } = vi.hoisted(() => ({
  broadcastMock: vi.fn().mockResolvedValue(undefined),
}));

// @/data を差し替え。getter で参照することでテスト中の上書きが反映される
vi.mock('@/data', () => ({
  get repos() {
    return repos;
  },
}));

// 認証は固定セッションを返すモックに置換 (sessionUserId / sessionRole は テスト中に切替可能)
vi.mock('@/lib/auth', () => ({
  auth: async () => ({
    user: { id: sessionUserId, role: sessionRole, tenantId: TENANT },
  }),
}));

// next/cache の副作用はテストには不要なので無効化する
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// SSE ブロードキャストを捕捉モックに置換 (broadcastMock で呼び出し回数・引数を検証する)
vi.mock('@/features/notifications/notify', () => ({
  broadcastUnreadCountToMany: broadcastMock,
}));

// テナント・ユーザーを投入する共通シード
// - TENANT に agent 2 名 (u-agt-1 = インポート実行者、u-agt-2 = 他エージェント)
// - TENANT に requester 1 名 (通知対象外)
function seed() {
  const now = new Date();
  // テナント (mode: lite → initialStatus は 'Open')
  store.tenants.set(TENANT, {
    id: TENANT,
    name: 'デフォルト組織',
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
    createdAt: now,
  });
  // インポート実行者 (agent)
  store.users.set('u-agt-1', {
    id: 'u-agt-1',
    email: 'agent1@example.com',
    name: 'エージェント1',
    passwordHash: 'x',
    role: 'agent',
    tenantId: TENANT,
    createdAt: now,
    updatedAt: now,
  });
  // 他エージェント (通知対象)
  store.users.set('u-agt-2', {
    id: 'u-agt-2',
    email: 'agent2@example.com',
    name: 'エージェント2',
    passwordHash: 'x',
    role: 'agent',
    tenantId: TENANT,
    createdAt: now,
    updatedAt: now,
  });
  // 依頼者 (エージェントではないため通知対象外)
  store.users.set('u-req-1', {
    id: 'u-req-1',
    email: 'req1@example.com',
    name: '依頼者1',
    passwordHash: 'x',
    role: 'requester',
    tenantId: TENANT,
    createdAt: now,
    updatedAt: now,
  });
}

// 動的 import: vi.mock 設定が反映された後で対象 Action を読み込む
async function loadAction() {
  // vi.resetModules() でキャッシュをリセットした後に import すると fresh な状態で取得できる
  const mod = await import('@/features/tickets/actions/import-tickets');
  return mod.importTickets;
}

// 各テストの前に依存をリセット (テスト間の独立性を確保)
beforeEach(() => {
  // メモリ context を新規作成してクリーンな状態にする
  const ctx = createMemoryContext();
  store = ctx.store; // ストアを最新の空コンテキストに差し替える
  repos = ctx.repos; // リポジトリ束を最新コンテキストに差し替える
  // セッション情報を既定に戻す
  sessionUserId = 'u-agt-1'; // インポート実行者のユーザー ID に戻す
  sessionRole = 'agent'; // デフォルトロールをエージェントに戻す
  // レート制限カウントを vi.resetModules() より前にクリアする。
  // vi.resetModules() 後はモジュールキャッシュが破棄されるため、
  // 静的 import の __resetRateLimits は新しいモジュールインスタンスを参照しなくなる。
  // 先にクリアすることで、リセット直後の現行インスタンスに対して確実に作用させる。
  __resetRateLimits();
  // vi.mock のファクトリが再適用されるよう、モジュールキャッシュを破棄する
  vi.resetModules();
  // SSE ブロードキャスト呼び出しの記録をリセットする
  broadcastMock.mockClear();
  // テナント・ユーザーのフィクスチャを投入する
  seed();
});

// ──────────────────────────────────────────────────
// テスト本体
// ──────────────────────────────────────────────────

describe('importTickets', () => {
  // ── 正常系 ──────────────────────────────────────
  describe('正常系', () => {
    // 基本的な CSV 取り込みが動作し、正しい tenantId / creatorId が付くことを確認する
    it('CSV を取り込んでチケットを作成し tenantId と creatorId が正しく設定される', async () => {
      const importTickets = await loadAction(); // モック差し替え済みの Action を動的ロード
      // 3 列 2 データ行を含む CSV (件名・内容・優先度の全列を含む典型的なフォーマット)
      const csv = `件名,内容,優先度\n問い合わせ1,詳細1,高\n問い合わせ2,詳細2,中`;
      const result = await importTickets(csv); // Action を実行してインポートを試みる

      // 2 件インポート成功、エラーなし
      expect(result.imported).toBe(2); // 成功件数が 2 であることを確認する
      expect(result.errors).toHaveLength(0); // エラーが発生していないことを確認する

      // DB に保存されたチケットを確認する
      const tickets = [...store.tickets.values()]; // メモリストアから全チケットを取り出す
      expect(tickets).toHaveLength(2); // チケットが 2 件保存されていることを確認する
      // 全チケットに正しいテナントと起票者が設定されていること (クロステナント漏洩防止の確認)
      for (const ticket of tickets) {
        expect(ticket.tenantId).toBe(TENANT); // テナント ID が正しく設定されているか確認
        expect(ticket.creatorId).toBe('u-agt-1'); // 起票者 ID がインポート実行者か確認
      }
      // 優先度が日本語から Priority 型に変換されていること
      const titles = tickets.map((t) => t.title); // 全チケットの件名を配列で取り出す
      expect(titles).toContain('問い合わせ1'); // 1 行目の件名が保存されていることを確認
      expect(titles).toContain('問い合わせ2'); // 2 行目の件名が保存されていることを確認
    });

    // Excel がエクスポートする UTF-8 CSV は BOM 付きのことがある。
    // BOM (﻿) が件名列の認識を阻害しないことを確認する。
    it('BOM 付き UTF-8 CSV を正しくパースできる', async () => {
      const importTickets = await loadAction(); // Action を動的ロードする
      // ﻿ (BOM) を先頭に付けた CSV (Excel の「UTF-8 BOM 付き」エクスポートを模擬)
      const csv = `﻿件名\nBOM テスト`;
      const result = await importTickets(csv); // BOM 付き CSV でインポートを実行する
      // BOM が除去されて件名列が認識される
      expect(result.imported).toBe(1); // 1 件インポートできることを確認する
      expect(result.errors).toHaveLength(0); // BOM によるパースエラーが発生しないことを確認する
    });

    // 優先度列がない場合は Medium にフォールバックされる
    it('優先度列がない行は Medium にフォールバックされる', async () => {
      const importTickets = await loadAction(); // Action を動的ロードする
      const csv = `件名\nテスト件名`; // 優先度列を持たない最小 CSV
      const result = await importTickets(csv); // 優先度なし CSV でインポートを実行する
      expect(result.imported).toBe(1); // 1 件インポートできることを確認する
      // フォールバック値の確認
      const ticket = [...store.tickets.values()][0]; // 保存されたチケットを 1 件取り出す
      expect(ticket?.priority).toBe('Medium'); // 優先度が Medium にフォールバックされていることを確認する
    });

    // YYYY-MM-DD 形式の期限日が正しく Date 型に変換されて保存される
    it('YYYY-MM-DD 形式の期限日が保存される', async () => {
      const importTickets = await loadAction(); // Action を動的ロードする
      const csv = `件名,期限日\ntest,2025-03-31`; // YYYY-MM-DD 形式の期限日を含む CSV
      const result = await importTickets(csv); // 期限日付き CSV でインポートを実行する
      expect(result.imported).toBe(1); // 1 件インポートできることを確認する
      // resolutionDueAt が null でないことを確認する
      const ticket = [...store.tickets.values()][0]; // 保存されたチケットを取り出す
      expect(ticket?.resolutionDueAt).not.toBeNull(); // 期限日が保存されていることを確認する
    });

    // 回帰防止: firstResponseDueAt が配線されておらず常に null のまま起票される不備があった。
    // CSV には対応列が無いため、期限日 (resolutionDueAt) の指定有無に関わらず優先度ベースで
    // 常に自動算出されることを確認する
    it('firstResponseDueAt が優先度ベースで自動算出される', async () => {
      const importTickets = await loadAction(); // Action を動的ロードする
      const csv = `件名\nテスト件名`; // 期限日列を持たない最小 CSV
      const result = await importTickets(csv);
      expect(result.imported).toBe(1);
      const ticket = [...store.tickets.values()][0];
      expect(ticket?.firstResponseDueAt).not.toBeNull();
    });

    // CSV インジェクション（=数式で始まる件名）はインポート時に加工しない。
    // 対策はエクスポート時 (AuditExportButton.tsx の escapeCSVCell) で行う設計方針のため、
    // DB には生の値が保存される (インポート時に ' を付加すると DB が汚染されるため)。
    it('数式形式の件名はそのまま保存される (エクスポート時に CSV インジェクション対策)', async () => {
      const importTickets = await loadAction(); // Action を動的ロードする
      const csv = `件名\n=SUM(A1:A10)`; // Excel の数式インジェクション攻撃パターン
      const result = await importTickets(csv); // 数式形式の件名を含む CSV でインポートを実行する
      expect(result.imported).toBe(1); // 1 件インポートできることを確認する
      // DB に保存された値が加工されていないことを確認する
      const ticket = [...store.tickets.values()][0]; // 保存されたチケットを取り出す
      expect(ticket?.title).toBe('=SUM(A1:A10)'); // 件名が ' などを付加されていない生の値で保存されていることを確認する
    });
  });

  // ── Phase 4 多拠点: 「拠点」列の名前解決 ──────────────────
  // CSV エクスポート (GET /api/tickets/export) が「拠点」列を出力するのに、
  // インポート側には対応する読み取りが存在せず、既存 Excel から一括取り込むと
  // 拠点情報が消えてしまっていた不備の回帰テスト。
  describe('拠点列 (Phase 4 多拠点)', () => {
    // テナントに拠点を 1 件登録しておくヘルパー
    async function seedLocation(name: string): Promise<string> {
      const location = await repos.locations.create({ tenantId: TENANT, name });
      return location.id;
    }

    // 「拠点」列の値が既存の拠点名と一致すれば locationId が解決されて保存される
    it('拠点名が一致すれば locationId が解決されて保存される', async () => {
      const locationId = await seedLocation('渋谷本店');
      const importTickets = await loadAction();
      const csv = `件名,拠点\n複合機の紙詰まり,渋谷本店`;
      const result = await importTickets(csv);

      expect(result.imported).toBe(1);
      expect(result.errors).toHaveLength(0);
      const ticket = [...store.tickets.values()][0];
      expect(ticket?.locationId).toBe(locationId);
    });

    // テナントに存在しない拠点名 (タイポ等) はエラーとして記録され、無言で拠点未設定にはならない
    it('存在しない拠点名はエラーとして記録され起票されない', async () => {
      await seedLocation('渋谷本店');
      const importTickets = await loadAction();
      const csv = `件名,拠点\n複合機の紙詰まり,存在しない拠点`;
      const result = await importTickets(csv);

      expect(result.imported).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('拠点が見つかりません');
      expect(store.tickets.size).toBe(0);
    });

    // 「拠点」列自体が無ければ従来どおり locationId は null のまま (後方互換)
    it('拠点列が無ければ locationId は null のまま取り込まれる', async () => {
      const importTickets = await loadAction();
      const csv = `件名\n複合機の紙詰まり`;
      const result = await importTickets(csv);

      expect(result.imported).toBe(1);
      const ticket = [...store.tickets.values()][0];
      expect(ticket?.locationId).toBeNull();
    });

    // 拠点列があっても空セルなら未指定として扱い、エラーにはしない
    it('拠点セルが空なら未指定として扱いエラーにしない', async () => {
      await seedLocation('渋谷本店');
      const importTickets = await loadAction();
      const csv = `件名,拠点\n複合機の紙詰まり,`;
      const result = await importTickets(csv);

      expect(result.imported).toBe(1);
      expect(result.errors).toHaveLength(0);
      const ticket = [...store.tickets.values()][0];
      expect(ticket?.locationId).toBeNull();
    });
  });

  // フォローアップ (2026-07-11): 「カテゴリ」列の名前解決
  // CSV エクスポート (GET /api/tickets/export) が「カテゴリ」列を出力するのに、インポート側には
  // 対応する読み取りが存在せず、エクスポート→編集→再インポートの往復でカテゴリ情報が消えて
  // いた不備の回帰テスト (拠点列の回帰テストと同じ構成)。
  describe('カテゴリ列 (フォローアップ 2026-07-11)', () => {
    // テナントにカテゴリを 1 件登録しておくヘルパー
    async function seedCategory(name: string): Promise<string> {
      const category = await repos.categories.create({ tenantId: TENANT, name });
      return category.id;
    }

    // カテゴリは Pro モード専用の概念 (TicketForm.tsx で Lite では非表示) のため、
    // 名前解決が実際に動く以下2件は Pro モードに切り替えてから検証する
    // (/code-review ultra 指摘対応 2026-07-11)。

    // 「カテゴリ」列の値が既存のカテゴリ名と一致すれば categoryId が解決されて保存される
    it('Pro テナントでカテゴリ名が一致すれば categoryId が解決されて保存される', async () => {
      const tenant = store.tenants.get(TENANT)!;
      store.tenants.set(TENANT, { ...tenant, mode: 'pro' });
      const categoryId = await seedCategory('ハードウェア');
      const importTickets = await loadAction();
      const csv = `件名,カテゴリ\n複合機の紙詰まり,ハードウェア`;
      const result = await importTickets(csv);

      expect(result.imported).toBe(1);
      expect(result.errors).toHaveLength(0);
      const ticket = [...store.tickets.values()][0];
      expect(ticket?.categoryId).toBe(categoryId);
    });

    // テナントに存在しないカテゴリ名 (タイポ等) はエラーとして記録され、無言で未分類にはならない
    it('Pro テナントで存在しないカテゴリ名はエラーとして記録され起票されない', async () => {
      const tenant = store.tenants.get(TENANT)!;
      store.tenants.set(TENANT, { ...tenant, mode: 'pro' });
      await seedCategory('ハードウェア');
      const importTickets = await loadAction();
      const csv = `件名,カテゴリ\n複合機の紙詰まり,存在しないカテゴリ`;
      const result = await importTickets(csv);

      expect(result.imported).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('カテゴリが見つかりません');
      expect(store.tickets.size).toBe(0);
    });

    // 「カテゴリ」列自体が無ければ従来どおり categoryId は null のまま (後方互換)
    it('カテゴリ列が無ければ categoryId は null のまま取り込まれる', async () => {
      const importTickets = await loadAction();
      const csv = `件名\n複合機の紙詰まり`;
      const result = await importTickets(csv);

      expect(result.imported).toBe(1);
      const ticket = [...store.tickets.values()][0];
      expect(ticket?.categoryId).toBeNull();
    });

    // カテゴリ列があっても空セルなら未指定として扱い、エラーにはしない
    it('カテゴリセルが空なら未指定として扱いエラーにしない', async () => {
      await seedCategory('ハードウェア');
      const importTickets = await loadAction();
      const csv = `件名,カテゴリ\n複合機の紙詰まり,`;
      const result = await importTickets(csv);

      expect(result.imported).toBe(1);
      expect(result.errors).toHaveLength(0);
      const ticket = [...store.tickets.values()][0];
      expect(ticket?.categoryId).toBeNull();
    });

    // 回帰テスト (/code-review ultra 指摘対応 2026-07-11): カテゴリは拠点と異なり Pro モード
    // 専用の概念 (TicketForm.tsx で Lite では非表示、POST /api/tickets でも常に null に強制)。
    // Lite テナント (seed() の既定) で有効なカテゴリ名を指定しても、名前解決を行わず categoryId は
    // null のまま起票され、かつエラーにもならない (Lite では「カテゴリ」列自体が意味を持たないため)
    it('Lite テナントではカテゴリ名が実在してもcategoryIdはnullのまま起票される', async () => {
      await seedCategory('ハードウェア');
      const importTickets = await loadAction();
      const csv = `件名,カテゴリ\n複合機の紙詰まり,ハードウェア`;
      const result = await importTickets(csv);

      expect(result.imported).toBe(1);
      expect(result.errors).toHaveLength(0);
      const ticket = [...store.tickets.values()][0];
      expect(ticket?.categoryId).toBeNull();
    });
  });

  // §3.1 フォローアップ (2026-07-10): 既存 Excel の完了済み行をそのまま取り込めるかを検証する
  describe('状況列 (§3.1 フォローアップ)', () => {
    // Lite テナント (seed() の既定) で「完了」を指定すると Closed で起票され、resolvedAt が
    // インポート時刻でセットされる (getCompletionStatuses(mode) との整合を確認)
    it('Lite テナントで「完了」を指定すると Closed かつ resolvedAt 付きで起票される', async () => {
      const importTickets = await loadAction();
      const csv = `件名,状況\n複合機の紙詰まり,完了`;
      const before = Date.now();
      const result = await importTickets(csv);
      const after = Date.now();

      expect(result.imported).toBe(1);
      expect(result.errors).toHaveLength(0);
      const ticket = [...store.tickets.values()][0];
      expect(ticket?.status).toBe('Closed');
      expect(ticket?.resolvedAt).toBeInstanceOf(Date);
      const resolvedAtMs = ticket!.resolvedAt!.getTime();
      expect(resolvedAtMs).toBeGreaterThanOrEqual(before);
      expect(resolvedAtMs).toBeLessThanOrEqual(after);
    });

    // 未完了系のラベル (「対応中」) を指定すると、そのステータスで起票されるが resolvedAt は null のまま
    it('未完了系のラベルを指定すると resolvedAt を設定せずに起票される', async () => {
      const importTickets = await loadAction();
      const csv = `件名,状況\n複合機の紙詰まり,対応中`;
      const result = await importTickets(csv);

      expect(result.imported).toBe(1);
      const ticket = [...store.tickets.values()][0];
      expect(ticket?.status).toBe('InProgress');
      expect(ticket?.resolvedAt).toBeNull();
    });

    // 「状況」列自体が無ければ従来どおりモードの既定初期ステータス (Lite: Open) で起票される (後方互換)
    it('状況列が無ければ既定の初期ステータスで起票される', async () => {
      const importTickets = await loadAction();
      const csv = `件名\n複合機の紙詰まり`;
      const result = await importTickets(csv);

      expect(result.imported).toBe(1);
      const ticket = [...store.tickets.values()][0];
      expect(ticket?.status).toBe('Open');
      expect(ticket?.resolvedAt).toBeNull();
    });

    // 状況セルが空なら未指定として扱い、既定の初期ステータスにフォールバックする (エラーにしない)
    it('状況セルが空なら既定の初期ステータスにフォールバックする', async () => {
      const importTickets = await loadAction();
      const csv = `件名,状況\n複合機の紙詰まり,`;
      const result = await importTickets(csv);

      expect(result.imported).toBe(1);
      expect(result.errors).toHaveLength(0);
      const ticket = [...store.tickets.values()][0];
      expect(ticket?.status).toBe('Open');
    });

    // Lite テナントに Pro 専用ラベル (「解決済み」) を指定すると、表示と入力の対称性が
    // 崩れるため一致させず、エラーとして記録する (静かに Resolved で起票しない)
    it('Lite テナントで Pro 専用ラベルを指定するとエラーになる', async () => {
      const importTickets = await loadAction();
      const csv = `件名,状況\n複合機の紙詰まり,解決済み`;
      const result = await importTickets(csv);

      expect(result.imported).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('状況の値が正しくありません');
      expect(store.tickets.size).toBe(0);
    });

    // 未知の値 (タイポ等) は静かに既定値へフォールバックさせず、エラーとして記録する
    it('未知の状況ラベルはエラーとして記録され起票されない', async () => {
      const importTickets = await loadAction();
      const csv = `件名,状況\n複合機の紙詰まり,対応済`;
      const result = await importTickets(csv);

      expect(result.imported).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('状況の値が正しくありません');
    });

    // Pro テナントでは Pro のステータスラベル (7 種) が使える
    it('Pro テナントでは Pro のステータスラベルで起票できる', async () => {
      // テナントを Pro モードに切り替える
      const tenant = store.tenants.get(TENANT)!;
      store.tenants.set(TENANT, { ...tenant, mode: 'pro' });
      const importTickets = await loadAction();
      const csv = `件名,状況\n複合機の紙詰まり,解決済み`;
      const result = await importTickets(csv);

      expect(result.imported).toBe(1);
      expect(result.errors).toHaveLength(0);
      const ticket = [...store.tickets.values()][0];
      expect(ticket?.status).toBe('Resolved');
      expect(ticket?.resolvedAt).toBeInstanceOf(Date);
    });

    // /code-review ultra 指摘対応 (2026-07-10): 「エスカレーション」は escalatedAt/理由の記録や
    // 全エージェント通知を伴う専用フロー (escalateTicket) を持つため、CSV インポートの状況列
    // から直接指定することはできない (履歴の無い矛盾したチケットを防ぐ)
    it('Pro テナントで「エスカレーション」を指定するとエラーになる', async () => {
      const tenant = store.tenants.get(TENANT)!;
      store.tenants.set(TENANT, { ...tenant, mode: 'pro' });
      const importTickets = await loadAction();
      const csv = `件名,状況\n複合機の紙詰まり,エスカレーション`;
      const result = await importTickets(csv);

      expect(result.imported).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('CSV インポートでは指定できません');
      const ticket = [...store.tickets.values()][0];
      expect(ticket).toBeUndefined();
    });
  });

  // ── Phase 4 課金: 月間チケット上限 (プランゲート) ──────────────────
  describe('月間チケット上限 (§6.1 料金プラン)', () => {
    // Free プランは月 50 件まで。CSV インポートも Web フォームと同じ上限を守ることを確認する
    it('Free プランで残枠を超える分はエラーとして記録され、残枠分だけ取り込まれる', async () => {
      // 当月分としてテナントに 48 件のチケットを事前に作成しておく (残枠 2 件)
      for (let i = 0; i < 48; i += 1) {
        await repos.tickets.create({
          title: `既存${i}`,
          body: '',
          priority: 'Medium',
          categoryId: null,
          creatorId: 'u-agt-1',
          tenantId: TENANT,
          status: 'Open',
          resolutionDueAt: null,
        });
      }
      const importTickets = await loadAction();
      // 5 行の CSV を取り込む (残枠 2 件を超える)
      const csv = `件名\n行1\n行2\n行3\n行4\n行5`;
      const result = await importTickets(csv);
      // 残枠 2 件分だけ成功する
      expect(result.imported).toBe(2);
      // 残り 3 件は上限エラーとして記録される
      expect(result.errors).toHaveLength(3);
      expect(result.errors[0]?.message).toContain('月間の問い合わせ件数が上限');
      // DB 上のチケット総数は上限の 50 件を超えない
      expect(store.tickets.size).toBe(50);
    });

    // Free 以外のプランは無制限なので、残枠チェックで取り込みが妨げられない
    it('Pro プランでは月間上限に妨げられず全件取り込まれる', async () => {
      // テナントのプランを Pro に切り替える (Free の 50 件上限は適用されない)
      store.tenants.set(TENANT, {
        ...store.tenants.get(TENANT)!,
        subscriptionPlan: 'pro' as const,
      });
      const importTickets = await loadAction();
      const csv = `件名\n行1\n行2\n行3`;
      const result = await importTickets(csv);
      // 3 件とも成功する
      expect(result.imported).toBe(3);
      expect(result.errors).toHaveLength(0);
    });
  });

  // ── RBAC ────────────────────────────────────────
  describe('RBAC (権限管理)', () => {
    // 依頼者 (requester) はエージェント専用操作のため拒否される
    it('requester は拒否される', async () => {
      sessionRole = 'requester'; // セッションロールを依頼者に切り替える
      const importTickets = await loadAction(); // 依頼者セッションで Action をロードする
      // 依頼者がインポートを試みた場合にエラーが投げられることを確認する
      await expect(importTickets('件名\nテスト')).rejects.toThrow(/エージェント|管理者/);
    });

    // admin はエージェント以上の権限を持つため実行できる
    it('admin は実行できる', async () => {
      sessionRole = 'admin'; // セッションロールを管理者に切り替える
      const importTickets = await loadAction(); // 管理者セッションで Action をロードする
      const result = await importTickets('件名\ntest'); // インポートを実行する
      expect(result.imported).toBe(1); // 管理者は 1 件インポートできることを確認する
    });
  });

  // ── CSV バリデーション ────────────────────────────
  describe('CSV バリデーション', () => {
    // 空行のみの CSV は処理できないため全体エラー
    it('空 CSV は全体エラーになる', async () => {
      const importTickets = await loadAction(); // Action を動的ロードする
      // 空白のみで構成された CSV を渡すと全体エラーが投げられることを確認する
      await expect(importTickets('   \n  ')).rejects.toThrow(/CSV が空/);
    });

    // 「件名」ヘッダ列がない CSV はチケット作成できない
    it('「件名」列がない CSV は全体エラーになる', async () => {
      const importTickets = await loadAction(); // Action を動的ロードする
      // 「件名」列を持たない CSV を渡すと全体エラーが投げられることを確認する
      await expect(importTickets('タイトル,内容\ntest,body')).rejects.toThrow(/件名/);
    });

    // 件名セルが空の行はその行だけスキップしてエラーに記録する (部分成功を許可)
    // 注意: 完全に空白の行は action 内の nonEmptyLines フィルタで除去されるため
    //       エラーは記録されない。件名セルが空になるのは「カンマはあるが先頭セルが空」の行。
    it('件名が空の行はスキップされエラー件数に記録される', async () => {
      const importTickets = await loadAction(); // Action を動的ロードする
      // 件名列が空 (,内容あり) の行 → 件名バリデーション失敗 → エラーに記録
      // その後ろに正常行を置いて部分成功を確認する
      const csv = `件名,内容\n,本文あり\n正常件名,正常本文`;
      const result = await importTickets(csv); // 件名空行を含む CSV でインポートを実行する
      // 正常行だけ取り込まれる
      expect(result.imported).toBe(1); // 正常行 1 件だけが取り込まれることを確認する
      // 件名が空の行がエラーとして記録される
      expect(result.errors).toHaveLength(1); // エラーが 1 件記録されていることを確認する
      expect(result.errors[0]?.message).toMatch(/件名が空/); // エラーメッセージが「件名が空」を含むことを確認する
    });

    // 空白だけの件名セル (引用符付きセルは前後空白が保持される) も「件名が空」として弾く
    it('空白だけの件名 (引用符付きセル) はエラーになる', async () => {
      const importTickets = await loadAction(); // Action を動的ロードする
      // 引用符付きの空白だけのセルは CSV パーサーが前後空白を保持したまま返すため、
      // trim() していないとタイトルが空白だけのチケットが作成されてしまう
      const csv = `件名,内容\n"   ",本文あり`;
      const result = await importTickets(csv); // 空白だけの件名を含む CSV でインポートを実行する
      // 取り込みは 0 件でエラーが 1 件記録される
      expect(result.imported).toBe(0); // 空白だけの件名は取り込まれないことを確認する
      expect(result.errors).toHaveLength(1); // エラーが 1 件記録されていることを確認する
      expect(result.errors[0]?.message).toMatch(/件名が空/); // エラーメッセージが「件名が空」を含むことを確認する
    });

    // 引用符付きの空白だけの本文セルは trim され、空文字として保存される (件名と同じ扱い)
    it('引用符付きの空白だけの本文は trim されて保存される', async () => {
      const importTickets = await loadAction(); // Action を動的ロードする
      // 本文セルが引用符付きの空白だけ → trim() で空文字になり保存される (本文は空文字を許容する設計)
      const csv = `件名,内容\n正常件名,"   "`;
      const result = await importTickets(csv); // 空白だけの本文を含む CSV でインポートを実行する
      expect(result.imported).toBe(1); // 本文は空文字許容のため取り込まれることを確認する
      const ticket = [...store.tickets.values()][0]; // 保存されたチケットを取り出す
      expect(ticket?.body).toBe(''); // 本文が trim 済みの空文字で保存されていることを確認する
    });

    // 未知の優先度文字列はその行だけエラーになる
    it('無効な優先度はその行だけエラーになる', async () => {
      const importTickets = await loadAction(); // Action を動的ロードする
      const csv = `件名,優先度\ntest,超高`; // 「高・中・低」以外の無効な優先度文字列を含む CSV
      const result = await importTickets(csv); // 無効優先度 CSV でインポートを実行する
      // 取り込みは 0 件でエラーが 1 件
      expect(result.imported).toBe(0); // 1 件も取り込まれないことを確認する
      expect(result.errors).toHaveLength(1); // エラーが 1 件記録されていることを確認する
      expect(result.errors[0]?.message).toMatch(/優先度/); // エラーメッセージが「優先度」を含むことを確認する
    });

    // YYYY-MM-DD 以外の日付形式はその行だけエラーになる
    it('無効な期限日形式はその行だけエラーになる', async () => {
      const importTickets = await loadAction(); // Action を動的ロードする
      const csv = `件名,期限日\ntest,2024/01/01`; // スラッシュ区切り (YYYY/MM/DD) は不正な形式
      const result = await importTickets(csv); // 不正な日付形式を含む CSV でインポートを実行する
      expect(result.imported).toBe(0); // 1 件も取り込まれないことを確認する
      expect(result.errors).toHaveLength(1); // エラーが 1 件記録されていることを確認する
      expect(result.errors[0]?.message).toMatch(/期限日/); // エラーメッセージが「期限日」を含むことを確認する
    });

    // MAX_ROWS (200 件) を超えるデータ行数は全体エラー (DoS 防止)
    it('200 行超過は全体エラーになる', async () => {
      const importTickets = await loadAction(); // Action を動的ロードする
      // 201 件のデータ行を生成する (200 件上限を 1 件超える量)
      const rows = Array.from({ length: 201 }, (_, i) => `件名${i}`).join('\n');
      const csv = `件名\n${rows}`; // ヘッダ行 + 201 データ行を結合した CSV
      // 行数超過で全体エラーが投げられることを確認する
      await expect(importTickets(csv)).rejects.toThrow(/200 行/);
    });

    // MAX_CSV_BYTES (512KB) を超える CSV は全体エラー (DoS / 過大ペイロード防止)
    it('512KB 超過の CSV は全体エラーになる', async () => {
      const importTickets = await loadAction(); // Action を動的ロードする
      // 512KB を超えるダミー文字列を生成する (1 バイト文字で 512 * 1024 + 1 バイト)
      const bigCsv = '件名\n' + 'a'.repeat(512 * 1024); // ヘッダ行 + 512KB 超の本文行
      // ペイロード超過で全体エラーが投げられることを確認する
      await expect(importTickets(bigCsv)).rejects.toThrow(/サイズが大きすぎ/);
    });
  });

  // ── 通知・SSE ブロードキャスト ────────────────────
  describe('通知・SSE ブロードキャスト', () => {
    // インポート後に他エージェントへ通知が作られ SSE ブロードキャストが呼ばれること
    it('インポート後に他エージェントへ通知が作成されブロードキャストが呼ばれる', async () => {
      const importTickets = await loadAction(); // Action を動的ロードする
      const csv = `件名\nテスト件名`; // 1 件のチケットを含む CSV
      await importTickets(csv); // インポートを実行して通知の副作用を発生させる

      // 通知レコードを確認する
      const notifications = [...store.notifications.values()]; // メモリストアから全通知を取り出す
      // 他エージェント (u-agt-2) の通知が 'imported' 種別で作成されている
      expect(notifications.some((n) => n.userId === 'u-agt-2' && n.type === 'imported')).toBe(true);
      // インポート実行者自身 (u-agt-1) への通知はない (自分の操作を自分に通知する必要はない)
      expect(notifications.some((n) => n.userId === 'u-agt-1')).toBe(false);
      // 依頼者 (u-req-1) への通知もない (エージェント向け通知のため listAgents が返さない)
      expect(notifications.some((n) => n.userId === 'u-req-1')).toBe(false);
      // SSE ブロードキャストが他エージェントの ID 一覧で呼ばれていることを確認する
      expect(broadcastMock).toHaveBeenCalledWith(['u-agt-2'], TENANT);
    });

    // 0 件インポート (ヘッダのみ) のときは通知・ブロードキャストが発生しない
    it('0 件インポートのとき通知・ブロードキャストは発生しない', async () => {
      const importTickets = await loadAction(); // Action を動的ロードする
      // ヘッダ行のみで実データなし → imported: 0
      const csv = `件名`; // データ行がなくヘッダのみの CSV
      const result = await importTickets(csv); // ヘッダのみ CSV でインポートを実行する
      expect(result.imported).toBe(0); // 0 件しか取り込まれないことを確認する
      // 通知レコードは 0 件
      expect([...store.notifications.values()]).toHaveLength(0); // 通知が一切作成されていないことを確認する
      // SSE ブロードキャストも呼ばれない
      expect(broadcastMock).not.toHaveBeenCalled(); // ブロードキャストが発生しないことを確認する
    });
  });

  // 回帰防止: 新規起票を Slack/Teams/Chatwork の外部チャネルへ通知する (Web フォーム/メール/LINE と共有)。
  // CSV は 1 回で最大 200 件を作成しうるため、他チャネルと違いチケットごとには送らず件数をまとめた
  // 1 通にする方針 (アプリ内通知と同じ「まとめて 1 通」)。
  describe('外部通知 (Slack/Teams/Chatwork)', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('ok') });
      vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('Slack Webhook 設定済みテナントでインポートすると件数をまとめて 1 通だけ通知される', async () => {
      const tenant = store.tenants.get(TENANT)!;
      store.tenants.set(TENANT, { ...tenant, slackWebhookUrl: SLACK_WEBHOOK_URL });

      const importTickets = await loadAction();
      // 3 件のチケットを含む CSV (200 件でも通知は 1 通であることの縮小版検証)
      const csv = `件名\n問い合わせ1\n問い合わせ2\n問い合わせ3`;
      const result = await importTickets(csv);
      expect(result.imported).toBe(3);

      // チケットごとではなく 1 回だけ通知される
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(SLACK_WEBHOOK_URL);
      // 件数が本文に含まれる
      expect(JSON.stringify(JSON.parse(init.body))).toContain('3件');
    });

    it('外部通知が未設定のテナントでインポートしても fetch は呼ばれない', async () => {
      const importTickets = await loadAction();
      const csv = `件名\nテスト件名`;
      await importTickets(csv);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('0 件インポートのときは外部通知も送らない', async () => {
      const tenant = store.tenants.get(TENANT)!;
      store.tenants.set(TENANT, { ...tenant, slackWebhookUrl: SLACK_WEBHOOK_URL });

      const importTickets = await loadAction();
      const csv = `件名`; // ヘッダのみ (0 件)
      const result = await importTickets(csv);
      expect(result.imported).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
