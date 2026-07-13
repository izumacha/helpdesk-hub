// 隔離済み受信メールリポジトリ (メモリアダプタ) の単体テスト。
// §3.2 フォローアップ (docs/smb-dx-pivot-plan.md): 未登録送信者・プラン未対応・認証失敗等で
// 起票されなかった受信メールが admin から一切確認できなかったギャップを埋めるために新設した
// リポジトリ。record/findAllByTenant の基本動作・テナント分離・キーセットページネーションを検証する。

import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos } from '@/data/ports/unit-of-work';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

let store: Store;
let repos: Repos;

describe('QuarantinedEmailRepository (memory)', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
  });

  // record した記録が findAllByTenant で読み出せること
  it('records and reads back a quarantined email', async () => {
    await repos.quarantinedEmails.record({
      tenantId: TENANT_A,
      channel: 'email',
      reason: 'unknown_sender',
      senderAddress: 'unknown@example.com',
      senderName: '知らない人',
      subject: 'テストメール',
    });

    const rows = await repos.quarantinedEmails.findAllByTenant({ tenantId: TENANT_A });
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('unknown_sender');
    expect(rows[0].senderAddress).toBe('unknown@example.com');
    expect(rows[0].senderName).toBe('知らない人');
    expect(rows[0].subject).toBe('テストメール');
    expect(rows[0].createdAt).toBeInstanceOf(Date);
  });

  // 新しい順に並ぶこと
  it('returns rows newest-first', async () => {
    await repos.quarantinedEmails.record({
      tenantId: TENANT_A,
      channel: 'email',
      reason: 'plan_gate',
      senderAddress: 'a@example.com',
      senderName: 'A',
      subject: '1件目',
    });
    // createdAt (Date.now()) が同一ミリ秒にならないよう間隔を空ける
    await new Promise((resolve) => setTimeout(resolve, 2));
    await repos.quarantinedEmails.record({
      tenantId: TENANT_A,
      channel: 'email',
      reason: 'quota_exceeded',
      senderAddress: 'b@example.com',
      senderName: 'B',
      subject: '2件目',
    });

    const rows = await repos.quarantinedEmails.findAllByTenant({ tenantId: TENANT_A });
    expect(rows.map((r) => r.subject)).toEqual(['2件目', '1件目']);
  });

  // 他テナントの記録が見えないこと (クロステナント漏洩防止)
  it('does not leak rows across tenants', async () => {
    await repos.quarantinedEmails.record({
      tenantId: TENANT_A,
      channel: 'email',
      reason: 'auth_fail',
      senderAddress: 'a@example.com',
      senderName: 'A',
      subject: 'テストメール',
    });

    const rowsForB = await repos.quarantinedEmails.findAllByTenant({ tenantId: TENANT_B });
    expect(rowsForB).toHaveLength(0);
  });

  // before カーソルより後 (同時刻含む) の行は除外され、「さらに読み込む」が正しく古い行へ辿れること。
  // record() は内部で new Date() を使い時刻を差し替えられないため、ストアへ直接行を投入して
  // createdAt / id を完全に制御する
  it('beforeを指定するとその日時より前の行だけに絞り込める', async () => {
    const older = new Date('2026-01-01T00:00:00.000Z');
    const newer = new Date('2026-01-01T00:00:01.000Z');
    store.quarantinedEmails.set('qte_older', {
      id: 'qte_older',
      tenantId: TENANT_A,
      channel: 'email',
      reason: 'plan_gate',
      senderAddress: 'a@example.com',
      senderName: 'A',
      lineUserId: null,
      subject: '古い方',
      createdAt: older,
    });
    store.quarantinedEmails.set('qte_newer', {
      id: 'qte_newer',
      tenantId: TENANT_A,
      channel: 'email',
      reason: 'quota_exceeded',
      senderAddress: 'b@example.com',
      senderName: 'B',
      lineUserId: null,
      subject: '新しい方',
      createdAt: newer,
    });

    const cursor = { createdAt: new Date('2026-01-01T00:00:00.500Z'), id: 'irrelevant' };
    const rows = await repos.quarantinedEmails.findAllByTenant({
      tenantId: TENANT_A,
      before: cursor,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toBe('古い方');
  });

  // createdAt が完全に同一の複数行があっても、id をタイブレーカーにしてページ境界で
  // 行を取りこぼさないこと (settings-audit-log-repository と同じ考え方)
  it('createdAtが同一の行はidで安定した順序に並び、カーソルで取りこぼさない', async () => {
    const sameInstant = new Date('2026-01-01T00:00:00.000Z');
    store.quarantinedEmails.set('qte_b', {
      id: 'qte_b',
      tenantId: TENANT_A,
      channel: 'email',
      reason: 'plan_gate',
      senderAddress: 'b@example.com',
      senderName: 'B',
      lineUserId: null,
      subject: 'B',
      createdAt: sameInstant,
    });
    store.quarantinedEmails.set('qte_a', {
      id: 'qte_a',
      tenantId: TENANT_A,
      channel: 'email',
      reason: 'plan_gate',
      senderAddress: 'a@example.com',
      senderName: 'A',
      lineUserId: null,
      subject: 'A',
      createdAt: sameInstant,
    });
    store.quarantinedEmails.set('qte_c', {
      id: 'qte_c',
      tenantId: TENANT_A,
      channel: 'email',
      reason: 'plan_gate',
      senderAddress: 'c@example.com',
      senderName: 'C',
      lineUserId: null,
      subject: 'C',
      createdAt: sameInstant,
    });

    // 1 ページ目: id 降順で 2 件だけ取得する (qte_c, qte_b が先頭 2 件になるはず)
    const page1 = await repos.quarantinedEmails.findAllByTenant({ tenantId: TENANT_A, limit: 2 });
    expect(page1.map((r) => r.id)).toEqual(['qte_c', 'qte_b']);

    // 2 ページ目: 1 ページ目の最後の行 (qte_b) をカーソルにすると、残りの qte_a だけが返る
    const page2 = await repos.quarantinedEmails.findAllByTenant({
      tenantId: TENANT_A,
      before: { createdAt: sameInstant, id: 'qte_b' },
    });
    expect(page2.map((r) => r.id)).toEqual(['qte_a']);
  });

  // フォローアップ (2026-07-13): 監査で発見したギャップの解消。LINE 取り込みもこのテーブルを
  // channel='line' で共有する。メール専用フィールド (senderAddress/senderName/subject) が
  // 埋まらなくても LINE 専用の lineUserId で記録・読み出しできることを確認する
  it('LINE 由来の隔離記録 (channel=line) を記録・読み出しできる', async () => {
    await repos.quarantinedEmails.record({
      tenantId: TENANT_A,
      channel: 'line',
      reason: 'no_agents',
      lineUserId: 'U00000000000000000000000000000001',
    });

    const rows = await repos.quarantinedEmails.findAllByTenant({ tenantId: TENANT_A });
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('line');
    expect(rows[0].reason).toBe('no_agents');
    expect(rows[0].lineUserId).toBe('U00000000000000000000000000000001');
    expect(rows[0].senderAddress).toBeNull();
    expect(rows[0].senderName).toBeNull();
    expect(rows[0].subject).toBeNull();
  });
});
