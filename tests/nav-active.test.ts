// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';

// テスト対象: サイドバーのメニュー項目アクティブ判定 (純粋関数)
import { isItemActive } from '../src/lib/nav-active';

// docs/pr-review-report.md 推奨フォローアップ「isItemActive のユニットテスト追加」に対応
describe('isItemActive', () => {
  // ルート "/" は完全一致のときのみアクティブ
  it('treats root "/" as active only on an exact match', () => {
    expect(isItemActive('/', '/', ['/'])).toBe(true);
    // ルート以外のパス配下でも "/" を誤ってアクティブにしない (prefix マッチを使わない特別扱い)
    expect(isItemActive('/dashboard', '/', ['/', '/dashboard'])).toBe(false);
  });

  // 完全一致は常にアクティブ
  it('is active on an exact pathname match', () => {
    expect(isItemActive('/tickets', '/tickets', ['/tickets', '/tickets/new'])).toBe(true);
  });

  // 配下パスは prefix マッチでアクティブ (他に完全一致する項目が無い場合)
  it('is active on a sub-path when no other nav item exactly matches', () => {
    expect(isItemActive('/tickets/123', '/tickets', ['/dashboard', '/tickets'])).toBe(true);
  });

  // /tickets/new のように「配下パス自身が別のメニュー項目と完全一致する」場合は
  // 親メニュー (/tickets) を誤ってアクティブにしない (デュアルハイライト防止)
  it('does not prefix-match when another nav item exactly matches the current pathname', () => {
    const navHrefs = ['/dashboard', '/tickets', '/tickets/new'];
    // /tickets/new 自身は完全一致でアクティブ
    expect(isItemActive('/tickets/new', '/tickets/new', navHrefs)).toBe(true);
    // 親の /tickets は prefix マッチ対象だが、/tickets/new が完全一致項目として存在するため非アクティブ
    expect(isItemActive('/tickets/new', '/tickets', navHrefs)).toBe(false);
  });

  // 無関係なパスは非アクティブ
  it('is inactive for unrelated paths', () => {
    expect(isItemActive('/faq', '/tickets', ['/faq', '/tickets'])).toBe(false);
  });

  // "/tickets-archive" のような紛らわしい別ページを "/tickets" の配下と誤認しない
  // (startsWith(`${href}/`) がスラッシュ区切りを要求するため、文字列としての prefix だけでは一致しない)
  it('does not match a sibling path that merely shares a string prefix', () => {
    expect(isItemActive('/tickets-archive', '/tickets', ['/tickets', '/tickets-archive'])).toBe(
      false,
    );
  });
});
