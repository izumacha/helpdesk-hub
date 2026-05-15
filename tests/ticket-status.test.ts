// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';

// 遷移可否判定と遷移先一覧取得を提供するドメイン関数 (Pro / Lite 両方)
import {
  getAllowedLiteTransitions,
  getAllowedTransitions,
  isLiteStatus,
  isValidLiteTransition,
  isValidTransition,
} from '../src/domain/ticket-status';

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

// Lite モード (SMB 向け簡易モード) の 3 ステータス遷移ルール (Pivot plan §5.2)
describe('Lite ticket status transition rules', () => {
  // Open から InProgress / Closed への遷移は許可されること
  it('allows Open to transition to InProgress or Closed', () => {
    // Open から行ける状態の集合を取得
    const allowed = getAllowedLiteTransitions('Open');
    // 必須の遷移先 (InProgress / Closed) が含まれていること
    expect(allowed).toContain('InProgress');
    expect(allowed).toContain('Closed');
    // 個別判定も true を返すこと
    expect(isValidLiteTransition('Open', 'InProgress')).toBe(true);
    expect(isValidLiteTransition('Open', 'Closed')).toBe(true);
  });

  // 自己遷移 (Open → Open など) は不可であること
  it('rejects self-transitions in Lite mode', () => {
    // Open → Open はループに見えるので不可
    expect(isValidLiteTransition('Open', 'Open')).toBe(false);
    // InProgress → InProgress も同様に不可
    expect(isValidLiteTransition('InProgress', 'InProgress')).toBe(false);
    // Closed → Closed も不可 (再オープンしてから完了し直すルートを取る)
    expect(isValidLiteTransition('Closed', 'Closed')).toBe(false);
  });

  // InProgress からは Open に戻す or Closed へ完了の 2 経路が許可されること
  it('allows InProgress to transition back to Open or forward to Closed', () => {
    // 対応中→未対応に戻すケースと、対応中→完了で終わらせるケースを許可
    expect(isValidLiteTransition('InProgress', 'Open')).toBe(true);
    expect(isValidLiteTransition('InProgress', 'Closed')).toBe(true);
  });

  // Closed からの遷移先は Open (再オープン) のみであること
  it('returns only Open as transition target from Closed', () => {
    // Lite モードでも完了状態からは再オープンのみ許可 (Pro モードと整合)
    expect(getAllowedLiteTransitions('Closed')).toEqual(['Open']);
    expect(isValidLiteTransition('Closed', 'Open')).toBe(true);
  });

  // isLiteStatus が 3 値で true、Lite 対象外の Pro ステータスで false を返すこと
  it('isLiteStatus returns true only for Open / InProgress / Closed', () => {
    // Lite で扱う 3 値はすべて true
    expect(isLiteStatus('Open')).toBe(true);
    expect(isLiteStatus('InProgress')).toBe(true);
    expect(isLiteStatus('Closed')).toBe(true);
    // 残り 4 値 (Pro 専用) はすべて false
    expect(isLiteStatus('New')).toBe(false);
    expect(isLiteStatus('WaitingForUser')).toBe(false);
    expect(isLiteStatus('Escalated')).toBe(false);
    expect(isLiteStatus('Resolved')).toBe(false);
  });
});
