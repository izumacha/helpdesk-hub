// buildGettingStartedSteps (src/lib/getting-started-steps.ts) の単体テスト。
// §7.1.2 フォローアップ (2026-07-10): メール取り込みを利用できないプラン (Free) では
// メール転送のオンボーディングステップを出さないことを固定する回帰テスト。

import { describe, expect, it } from 'vitest';
import { buildGettingStartedSteps } from '@/lib/getting-started-steps';

describe('buildGettingStartedSteps', () => {
  // メール取り込みが使えるプランでは 3 ステップ (招待 → メール転送 → スマホ) になる
  it('メール取り込みが使えるプランでは3ステップになる', () => {
    const steps = buildGettingStartedSteps(true);

    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.title)).toEqual([
      'スタッフを招待する',
      'メールの転送アドレスを設定する',
      'スマホから試してみる',
    ]);
    // ステップ番号が 1,2,3 と連番であること
    expect(steps.map((s) => s.step)).toEqual([1, 2, 3]);
  });

  // メール取り込みが使えないプラン (Free 等) ではメール転送ステップを含めない
  it('メール取り込みが使えないプランではメール転送ステップを含めない', () => {
    const steps = buildGettingStartedSteps(false);

    expect(steps).toHaveLength(2);
    expect(steps.map((s) => s.title)).toEqual(['スタッフを招待する', 'スマホから試してみる']);
    // メール転送ステップが無いテキスト (「転送」を含む文言) が一切出てこないこと
    expect(steps.every((s) => !s.title.includes('転送') && !s.description.includes('転送'))).toBe(
      true,
    );
  });

  // メール転送ステップを省いた場合でも、残りのステップ番号は歯抜けにならず 1,2 と詰まること
  it('メール転送ステップを省いてもステップ番号が歯抜けにならない', () => {
    const steps = buildGettingStartedSteps(false);

    expect(steps.map((s) => s.step)).toEqual([1, 2]);
  });
});
