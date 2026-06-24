// LINE 紐付けワンタイムコードのヘルパー (純粋ロジック) の単体テスト。
// 生成形式・正規化・形判定・ハッシュ整合 (発行側と Webhook 側で一致するか) を検証する。

import { describe, expect, it } from 'vitest';
import {
  generateLineLinkCode,
  hashLineLinkCode,
  looksLikeLineLinkCode,
  normalizeLineLinkCode,
  LINE_LINK_CODE_LENGTH,
} from '@/lib/line-link';

describe('generateLineLinkCode', () => {
  // 生成コードは「4 文字 + ハイフン + 4 文字」で、正規化すると規定長になる
  it('ハイフン区切りで生成し、正規化すると規定長になる', () => {
    const code = generateLineLinkCode();
    // 表示形式はハイフンを 1 つ含む
    expect(code).toContain('-');
    // 正規化 (ハイフン除去) すると LINE_LINK_CODE_LENGTH 文字
    expect(normalizeLineLinkCode(code)).toHaveLength(LINE_LINK_CODE_LENGTH);
    // 正規化後はコードの形と判定される
    expect(looksLikeLineLinkCode(normalizeLineLinkCode(code))).toBe(true);
  });

  // 紛らわしい文字 (I/L/O/U) を含まない
  it('紛らわしい文字 (I/L/O/U) を含まない', () => {
    const normalized = normalizeLineLinkCode(generateLineLinkCode());
    expect(normalized).not.toMatch(/[ILOU]/);
  });

  // 連続生成でコードが毎回変わる (乱数性の最低限の確認)
  it('呼ぶたびに異なるコードを返す', () => {
    const a = generateLineLinkCode();
    const b = generateLineLinkCode();
    expect(a).not.toBe(b);
  });
});

describe('normalizeLineLinkCode', () => {
  // 小文字・空白・ハイフンを除去して大文字に揃える
  it('小文字・空白・ハイフンを正規化する', () => {
    expect(normalizeLineLinkCode(' ab7k-9qf2 ')).toBe('AB7K9QF2');
  });
});

describe('looksLikeLineLinkCode', () => {
  // 規定長かつ全文字がコード用アルファベットなら true
  it('規定長のコード形なら true', () => {
    expect(looksLikeLineLinkCode('AB7K9QF2')).toBe(true);
  });

  // 長さ違いは false
  it('長さが違えば false', () => {
    expect(looksLikeLineLinkCode('AB7K9QF')).toBe(false);
    expect(looksLikeLineLinkCode('AB7K9QF23')).toBe(false);
  });

  // 紛らわしい除外文字を含むと false (通常の問い合わせ文を弾く)
  it('除外文字 (I/L/O/U) を含むと false', () => {
    expect(looksLikeLineLinkCode('ABILOUXX')).toBe(false);
  });
});

describe('hashLineLinkCode', () => {
  // 同じ正規化入力からは同じハッシュ (発行側と Webhook 側で一致する) になる
  it('同じ入力から同じハッシュを返す (発行と照合の整合)', async () => {
    const code = generateLineLinkCode();
    const fromIssuer = await hashLineLinkCode(normalizeLineLinkCode(code));
    // Webhook 側はユーザーがハイフン無し・小文字で送ってきても正規化して同じハッシュになる
    const fromWebhook = await hashLineLinkCode(
      normalizeLineLinkCode(code.toLowerCase().replace('-', '')),
    );
    expect(fromIssuer).toBe(fromWebhook);
  });
});
