// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';

// 遷移可否判定と遷移先一覧取得を提供するドメイン関数
import { getAllowedTransitions, isValidTransition } from '../src/domain/ticket-status';

// チケットステータスの遷移ルール (= 仕様の単一真実) を守れているかのテスト
describe('ticket status transition rules', () => {
  // InProgress から想定通りの遷移先が許可されること
  it('allows valid transitions from InProgress', () => {
    // InProgress から行ける状態の集合
    const allowed = getAllowedTransitions('InProgress');
    // 必須の遷移先が含まれていること
    expect(allowed).toContain('WaitingForUser');
    expect(allowed).toContain('Escalated');
    expect(allowed).toContain('Resolved');
    // 個別判定でも true を返すこと
    expect(isValidTransition('InProgress', 'Resolved')).toBe(true);
    expect(isValidTransition('InProgress', 'Escalated')).toBe(true);
  });

  // 解決済みから再オープン (Open) への巻き戻しが許可されること
  it('allows reopening from Resolved to Open', () => {
    expect(isValidTransition('Resolved', 'Open')).toBe(true);
  });

  // クローズ済みからの再オープンも許可されること
  it('allows reopening Closed ticket to Open', () => {
    expect(isValidTransition('Closed', 'Open')).toBe(true);
  });

  // 不正な遷移は false を返すこと
  it('rejects invalid transitions', () => {
    // クローズ済みから直接 InProgress には戻せない
    expect(isValidTransition('Closed', 'InProgress')).toBe(false);
    // Escalated から New に戻すのは不可
    expect(isValidTransition('Escalated', 'New')).toBe(false);
  });

  // Closed からの遷移先は Open のみであること
  it('returns empty array for Closed (except Open)', () => {
    const allowed = getAllowedTransitions('Closed');
    expect(allowed).toEqual(['Open']);
  });
});
