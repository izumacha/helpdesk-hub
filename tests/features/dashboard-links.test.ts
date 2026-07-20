// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';
// テスト対象の純粋関数
import { buildTicketListHref } from '@/features/tickets/dashboard-links';

// 監査で発見したギャップ対応 (2026-07-20): ダッシュボードの drill-down リンクが選択中の
// 拠点フィルタを引き継ぐこと (§4.1/§4.1.1 で追加した拠点フィルタが一覧遷移で消えていた)
describe('buildTicketListHref', () => {
  // 拠点未選択 (undefined) なら、渡した条件だけで一覧へのパスを組み立てること
  it('拠点が未選択なら locationId を含めない', () => {
    expect(buildTicketListHref('status=Open', undefined)).toBe('/tickets?status=Open');
  });

  // 拠点選択中なら、既存の条件を保ったまま locationId を末尾に付け足すこと
  it('拠点選択中なら既存の条件を維持したまま locationId を付け足す', () => {
    expect(buildTicketListHref('status=Open', 'loc-1')).toBe('/tickets?status=Open&locationId=loc-1');
  });

  // Lite ダッシュボードのタブ遷移 (tab=mine 等) でも同様に付け足せること
  it('tab クエリでも同様に locationId を付け足す', () => {
    expect(buildTicketListHref('tab=overdue', 'loc-2')).toBe('/tickets?tab=overdue&locationId=loc-2');
  });
});
