// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';

// FAQ 状態の遷移可否判定を提供するドメイン関数
import { isValidFaqTransition } from '../src/domain/faq-status';

// FAQ ステータスの遷移ルール (= 仕様の単一真実) を守れているかのテスト
// (フォローアップ 2026-07-14 #6: Published → Rejected の非公開化を追加した際に新設)
describe('faq status transition rules', () => {
  // Candidate から公開/却下のどちらへも遷移できること
  it('allows Candidate to transition to Published or Rejected', () => {
    expect(isValidFaqTransition('Candidate', 'Published')).toBe(true);
    expect(isValidFaqTransition('Candidate', 'Rejected')).toBe(true);
  });

  // Published から Rejected (非公開化) への遷移が許可されること
  it('allows Published to transition to Rejected (非公開化)', () => {
    expect(isValidFaqTransition('Published', 'Rejected')).toBe(true);
  });

  // Published から Candidate への巻き戻しは対象外であること
  it('does not allow Published to transition back to Candidate', () => {
    expect(isValidFaqTransition('Published', 'Candidate')).toBe(false);
  });

  // Rejected からはどの状態へも遷移できないこと (候補への差し戻しは対象外)
  it('does not allow any transition from Rejected', () => {
    expect(isValidFaqTransition('Rejected', 'Candidate')).toBe(false);
    expect(isValidFaqTransition('Rejected', 'Published')).toBe(false);
  });
});
