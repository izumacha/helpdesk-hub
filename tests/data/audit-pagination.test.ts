// 監査ログ系リポジトリ共通のキーセットページネーション比較ロジック (src/data/adapters/audit-pagination.ts)
// の単体テスト。純粋関数のみを対象にする (CLAUDE.md §11: 純粋ロジックはユニットテスト)。
//
// /code-review ultra 再指摘対応 (2026-07-10, §4.2.1 フォローアップ再訪): TicketHistory /
// SettingsAuditLog という由来の異なる 2 テーブルをマージ表示する監査ログ画面では、
// 「まだ 1 件も表示していないテーブル」の行を誤って除外しないことが最重要。この境界条件を
// メモリ/Prisma アダプタの統合テストに頼らず、比較ロジック単体で明示的に固定する。

import { describe, expect, it } from 'vitest';
import { isBeforeAuditCursor } from '@/data/adapters/audit-pagination';

describe('isBeforeAuditCursor', () => {
  // createdAt が異なる場合は単純な大小比較になる (kind/id は無視される)
  it('createdAtが異なる場合は日時だけで判定する', () => {
    const cursor = {
      createdAt: new Date('2026-01-01T00:00:00.500Z'),
      kind: 'ticket' as const,
      id: 'x',
    };
    // カーソルより前の日時は対象 (true)
    expect(isBeforeAuditCursor(new Date('2026-01-01T00:00:00.000Z'), 'settings', 'z', cursor)).toBe(
      true,
    );
    // カーソルより後の日時は対象外 (false)
    expect(isBeforeAuditCursor(new Date('2026-01-01T00:00:01.000Z'), 'settings', 'a', cursor)).toBe(
      false,
    );
  });

  // 同一 createdAt かつ同じ kind (同じテーブル由来) なら id で判定する
  it('createdAtとkindが同じ場合はidの大小で判定する', () => {
    const sameInstant = new Date('2026-01-01T00:00:00.000Z');
    const cursor = { createdAt: sameInstant, kind: 'ticket' as const, id: 'hst_b' };
    // id がカーソルより小さければ対象 (まだ表示していない側)
    expect(isBeforeAuditCursor(sameInstant, 'ticket', 'hst_a', cursor)).toBe(true);
    // id がカーソル以上なら対象外 (既に表示済み、またはカーソル自身)
    expect(isBeforeAuditCursor(sameInstant, 'ticket', 'hst_c', cursor)).toBe(false);
    expect(isBeforeAuditCursor(sameInstant, 'ticket', 'hst_b', cursor)).toBe(false);
  });

  // /code-review ultra 再指摘対応の本題: 同一 createdAt でカーソルが別テーブル (kind) 由来の場合。
  // マージ順序は 'ticket' が 'settings' より先という取り決め (AuditPaginationCursor 参照)。
  it('カーソルが別テーブル由来の場合、マージ順序上まだ表示していないテーブルは全件が対象になる', () => {
    const sameInstant = new Date('2026-01-01T00:00:00.000Z');
    // カーソルが 'ticket' 由来 (= この createdAt 時点で 'settings' 側はまだ 1 件も表示していない)
    const cursorFromTicket = { createdAt: sameInstant, kind: 'ticket' as const, id: 'hst_z' };
    // 'settings' 側の任意の id (id の大小に関わらず) が対象になるべき
    // (id だけのカーソルだったら 'hst_z' より id が大きい 'sal' 行は誤って除外されていた)
    expect(isBeforeAuditCursor(sameInstant, 'settings', 'zzz_row', cursorFromTicket)).toBe(true);
    expect(isBeforeAuditCursor(sameInstant, 'settings', 'aaa_row', cursorFromTicket)).toBe(true);
  });

  it('カーソルが別テーブル由来の場合、マージ順序上既に表示し終えたテーブルは全件が対象外になる', () => {
    const sameInstant = new Date('2026-01-01T00:00:00.000Z');
    // カーソルが 'settings' 由来 (= この createdAt 時点で 'ticket' 側は既に全件表示済みのはず)
    const cursorFromSettings = { createdAt: sameInstant, kind: 'settings' as const, id: 'sal_z' };
    // 'ticket' 側の任意の id (id の大小に関わらず) は対象外になるべき
    // (id だけのカーソルだったら 'sal_z' より id が小さい 'hst' 行を誤って含めていた)
    expect(isBeforeAuditCursor(sameInstant, 'ticket', 'aaa_row', cursorFromSettings)).toBe(false);
    expect(isBeforeAuditCursor(sameInstant, 'ticket', 'zzz_row', cursorFromSettings)).toBe(false);
  });
});
