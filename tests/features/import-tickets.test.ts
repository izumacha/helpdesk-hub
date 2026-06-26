// importTickets Server Action の単体テスト。
// CSV パース・バリデーション・テナントスコープ・RBAC・通知連携・CSV インジェクション方針を検証する。
// 外部 DB・SSE・メール送信は一切行わず、メモリ Adapter とモックで完結する。

// Vitest の DSL とモック
import { beforeEach, describe, expect, it, vi } from 'vitest';
// メモリ Adapter の context (store/repos)
import { createMemoryContext, type Store } from '@/data/adapters/memory';
// リポジトリ束の型
import type { Repos } from '@/data/ports/unit-of-work';
// レート制限をテスト間でクリアする内部用関数
import { __resetRateLimits } from '@/lib/rate-limit';

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
  store = ctx.store;
  repos = ctx.repos;
  // セッション情報を既定に戻す
  sessionUserId = 'u-agt-1';
  sessionRole = 'agent';
  // vi.mock のファクトリが再適用されるよう、モジュールキャッシュを破棄する
  vi.resetModules();
  // 前テストのレート制限カウントを引き継がないようクリアする
  __resetRateLimits();
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
      const importTickets = await loadAction();
      // 3 列 2 データ行を含む CSV
      const csv = `件名,内容,優先度\n問い合わせ1,詳細1,高\n問い合わせ2,詳細2,中`;
      const result = await importTickets(csv);

      // 2 件インポート成功、エラーなし
      expect(result.imported).toBe(2);
      expect(result.errors).toHaveLength(0);

      // DB に保存されたチケットを確認する
      const tickets = [...store.tickets.values()];
      expect(tickets).toHaveLength(2);
      // 全チケットに正しいテナントと起票者が設定されていること (クロステナント漏洩防止の確認)
      for (const ticket of tickets) {
        expect(ticket.tenantId).toBe(TENANT);
        expect(ticket.creatorId).toBe('u-agt-1');
      }
      // 優先度が日本語から Priority 型に変換されていること
      const titles = tickets.map((t) => t.title);
      expect(titles).toContain('問い合わせ1');
      expect(titles).toContain('問い合わせ2');
    });

    // Excel がエクスポートする UTF-8 CSV は BOM 付きのことがある。
    // BOM (﻿) が件名列の認識を阻害しないことを確認する。
    it('BOM 付き UTF-8 CSV を正しくパースできる', async () => {
      const importTickets = await loadAction();
      // ﻿ (BOM) を先頭に付けた CSV
      const csv = `﻿件名\nBOM テスト`;
      const result = await importTickets(csv);
      // BOM が除去されて件名列が認識される
      expect(result.imported).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    // 優先度列がない場合は Medium にフォールバックされる
    it('優先度列がない行は Medium にフォールバックされる', async () => {
      const importTickets = await loadAction();
      const csv = `件名\nテスト件名`;
      const result = await importTickets(csv);
      expect(result.imported).toBe(1);
      // フォールバック値の確認
      const ticket = [...store.tickets.values()][0];
      expect(ticket?.priority).toBe('Medium');
    });

    // YYYY-MM-DD 形式の期限日が正しく Date 型に変換されて保存される
    it('YYYY-MM-DD 形式の期限日が保存される', async () => {
      const importTickets = await loadAction();
      const csv = `件名,期限日\ntest,2025-03-31`;
      const result = await importTickets(csv);
      expect(result.imported).toBe(1);
      // resolutionDueAt が null でないことを確認する
      const ticket = [...store.tickets.values()][0];
      expect(ticket?.resolutionDueAt).not.toBeNull();
    });

    // CSV インジェクション（=数式で始まる件名）はインポート時に加工しない。
    // 対策はエクスポート時 (AuditExportButton.tsx の escapeCSVCell) で行う設計方針のため、
    // DB には生の値が保存される (インポート時に ' を付加すると DB が汚染されるため)。
    it('数式形式の件名はそのまま保存される (エクスポート時に CSV インジェクション対策)', async () => {
      const importTickets = await loadAction();
      const csv = `件名\n=SUM(A1:A10)`;
      const result = await importTickets(csv);
      expect(result.imported).toBe(1);
      // DB に保存された値が加工されていないことを確認する
      const ticket = [...store.tickets.values()][0];
      expect(ticket?.title).toBe('=SUM(A1:A10)');
    });
  });

  // ── RBAC ────────────────────────────────────────
  describe('RBAC (権限管理)', () => {
    // 依頼者 (requester) はエージェント専用操作のため拒否される
    it('requester は拒否される', async () => {
      sessionRole = 'requester';
      const importTickets = await loadAction();
      await expect(importTickets('件名\nテスト')).rejects.toThrow(/エージェント|管理者/);
    });

    // admin はエージェント以上の権限を持つため実行できる
    it('admin は実行できる', async () => {
      sessionRole = 'admin';
      const importTickets = await loadAction();
      const result = await importTickets('件名\ntest');
      expect(result.imported).toBe(1);
    });
  });

  // ── CSV バリデーション ────────────────────────────
  describe('CSV バリデーション', () => {
    // 空行のみの CSV は処理できないため全体エラー
    it('空 CSV は全体エラーになる', async () => {
      const importTickets = await loadAction();
      await expect(importTickets('   \n  ')).rejects.toThrow(/CSV が空/);
    });

    // 「件名」ヘッダ列がない CSV はチケット作成できない
    it('「件名」列がない CSV は全体エラーになる', async () => {
      const importTickets = await loadAction();
      await expect(importTickets('タイトル,内容\ntest,body')).rejects.toThrow(/件名/);
    });

    // 件名セルが空の行はその行だけスキップしてエラーに記録する (部分成功を許可)
    // 注意: 完全に空白の行は action 内の nonEmptyLines フィルタで除去されるため
    //       エラーは記録されない。件名セルが空になるのは「カンマはあるが先頭セルが空」の行。
    it('件名が空の行はスキップされエラー件数に記録される', async () => {
      const importTickets = await loadAction();
      // 件名列が空 (,内容あり) の行 → 件名バリデーション失敗 → エラーに記録
      // その後ろに正常行を置いて部分成功を確認する
      const csv = `件名,内容\n,本文あり\n正常件名,正常本文`;
      const result = await importTickets(csv);
      // 正常行だけ取り込まれる
      expect(result.imported).toBe(1);
      // 件名が空の行がエラーとして記録される
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message).toMatch(/件名が空/);
    });

    // 未知の優先度文字列はその行だけエラーになる
    it('無効な優先度はその行だけエラーになる', async () => {
      const importTickets = await loadAction();
      const csv = `件名,優先度\ntest,超高`;
      const result = await importTickets(csv);
      // 取り込みは 0 件でエラーが 1 件
      expect(result.imported).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message).toMatch(/優先度/);
    });

    // YYYY-MM-DD 以外の日付形式はその行だけエラーになる
    it('無効な期限日形式はその行だけエラーになる', async () => {
      const importTickets = await loadAction();
      const csv = `件名,期限日\ntest,2024/01/01`;
      const result = await importTickets(csv);
      expect(result.imported).toBe(0);
      expect(result.errors[0]?.message).toMatch(/期限日/);
    });

    // MAX_ROWS (200 件) を超えるデータ行数は全体エラー (DoS 防止)
    it('200 行超過は全体エラーになる', async () => {
      const importTickets = await loadAction();
      // 201 件のデータ行を生成する
      const rows = Array.from({ length: 201 }, (_, i) => `件名${i}`).join('\n');
      const csv = `件名\n${rows}`;
      await expect(importTickets(csv)).rejects.toThrow(/200 行/);
    });
  });

  // ── 通知・SSE ブロードキャスト ────────────────────
  describe('通知・SSE ブロードキャスト', () => {
    // インポート後に他エージェントへ通知が作られ SSE ブロードキャストが呼ばれること
    it('インポート後に他エージェントへ通知が作成されブロードキャストが呼ばれる', async () => {
      const importTickets = await loadAction();
      const csv = `件名\nテスト件名`;
      await importTickets(csv);

      // 通知レコードを確認する
      const notifications = [...store.notifications.values()];
      // 他エージェント (u-agt-2) の通知が 'imported' 種別で作成されている
      expect(notifications.some((n) => n.userId === 'u-agt-2' && n.type === 'imported')).toBe(true);
      // インポート実行者自身 (u-agt-1) への通知はない (自分の操作を自分に通知する必要はない)
      expect(notifications.some((n) => n.userId === 'u-agt-1')).toBe(false);
      // 依頼者 (u-req-1) への通知もない (エージェント向け通知のため)
      expect(notifications.some((n) => n.userId === 'u-req-1')).toBe(false);
      // SSE ブロードキャストが他エージェントの ID 一覧で呼ばれている
      expect(broadcastMock).toHaveBeenCalledWith(['u-agt-2'], TENANT);
    });

    // 0 件インポート (ヘッダのみ) のときは通知・ブロードキャストが発生しない
    it('0 件インポートのとき通知・ブロードキャストは発生しない', async () => {
      const importTickets = await loadAction();
      // ヘッダ行のみで実データなし → imported: 0
      const csv = `件名`;
      const result = await importTickets(csv);
      expect(result.imported).toBe(0);
      // 通知レコードは 0 件
      expect([...store.notifications.values()]).toHaveLength(0);
      // SSE ブロードキャストも呼ばれない
      expect(broadcastMock).not.toHaveBeenCalled();
    });
  });
});
