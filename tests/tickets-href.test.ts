// テストランナー (Vitest) の API
import { describe, it, expect } from 'vitest';
// 検証対象: チケット一覧の URL を組み立てる純粋関数
import { buildTicketsHref } from '@/features/tickets/tickets-href';

// 一覧 URL の組み立て規則を固定する。
// この関数はページャ・期限チップ・タブ・絞り込みフォームの 4 箇所が共有しているので、
// 規則が変わるとどの画面のリンクも同時に変わる (だからこそ 1 か所に置いてある)
describe('buildTicketsHref', () => {
  // クエリが 1 つも無いときに "?" だけが残った URL を作らないこと
  it('クエリが空なら "?" を付けない', () => {
    // 空のクエリから組み立てる
    expect(buildTicketsHref({})).toBe('/tickets');
    // URLSearchParams でも同じ結果になる
    expect(buildTicketsHref(new URLSearchParams())).toBe('/tickets');
  });

  // 値が undefined のキーは URL に載せないこと (サーバ側の searchParams は undefined を含む)
  it('値が undefined のキーは載せない', () => {
    // q だけが値を持つ状態
    expect(buildTicketsHref({ q: 'vpn', status: undefined })).toBe('/tickets?q=vpn');
  });

  // 絞り込みやタブを変えたら必ず 1 ページ目へ戻すこと
  // (2 ページ目のまま条件だけ変わって「0 件」になるのを防ぐ)
  it('page は既定で必ず取り除く', () => {
    // page=3 を持っていても落ちる
    expect(buildTicketsHref({ q: 'vpn', page: '3' })).toBe('/tickets?q=vpn');
  });

  // ページャ自身は「page を差し替えたい」ので、set で明示したときは尊重すること
  it('set で page を明示したときはその値を残す', () => {
    // ページャの呼び出し方 (page だけ差し替える)
    expect(buildTicketsHref({ q: 'vpn', page: '3' }, { set: { page: '2' } })).toBe(
      '/tickets?q=vpn&page=2',
    );
  });

  // remove で指定したキーが落ちること (期限チップの解除リンク・タブ切替の due リセット)
  it('remove で指定したキーを取り除く', () => {
    // due を外し、他は維持する
    expect(buildTicketsHref({ q: 'vpn', due: 'soon', tab: 'overdue' }, { remove: ['due'] })).toBe(
      '/tickets?q=vpn&tab=overdue',
    );
  });

  // set は既存の値を上書きすること
  it('set は既存の値を上書きする', () => {
    // tab を mine から overdue へ差し替える
    expect(buildTicketsHref({ tab: 'mine' }, { set: { tab: 'overdue' } })).toBe(
      '/tickets?tab=overdue',
    );
  });

  // 元の URLSearchParams を書き換えないこと (呼び出し側は React の searchParams を渡すため)
  it('渡された URLSearchParams を書き換えない', () => {
    // 元になるクエリ
    const source = new URLSearchParams('q=vpn&page=3');
    // 組み立てる (page は落ちる)
    buildTicketsHref(source, { remove: ['q'] });
    // 元のオブジェクトは無傷であること
    expect(source.toString()).toBe('q=vpn&page=3');
  });
});
