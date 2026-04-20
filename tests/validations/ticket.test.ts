// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';
// 検証対象の Zod スキーマ群
import {
  commentBodySchema,
  createTicketSchema,
  escalationReasonSchema,
} from '@/lib/validations/ticket';
// FAQ 候補入力スキーマ
import { faqCandidateSchema } from '@/lib/validations/faq';

// チケット作成スキーマの境界値テスト
describe('createTicketSchema', () => {
  // 共通の正常系入力
  const base = { title: 'タイトル', body: '内容', priority: 'Medium' as const };

  // 本文 10000 文字までは許容
  it('accepts a 10,000-character body', () => {
    const r = createTicketSchema.safeParse({ ...base, body: 'a'.repeat(10_000) });
    expect(r.success).toBe(true);
  });

  // 本文 10001 文字は弾き、メッセージに上限値を含む
  it('rejects a 10,001-character body with a Japanese message', () => {
    const r = createTicketSchema.safeParse({ ...base, body: 'a'.repeat(10_001) });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toMatch(/10000/);
    }
  });

  // タイトル 201 文字は弾く
  it('rejects a 201-character title', () => {
    const r = createTicketSchema.safeParse({ ...base, title: 'a'.repeat(201) });
    expect(r.success).toBe(false);
  });
});

// コメント本文スキーマ
describe('commentBodySchema', () => {
  // 5000 文字までは OK
  it('accepts 5,000 characters', () => {
    expect(commentBodySchema.safeParse('x'.repeat(5_000)).success).toBe(true);
  });

  // 5001 文字は NG (メッセージに 5000 を含む)
  it('rejects 5,001 characters', () => {
    const r = commentBodySchema.safeParse('x'.repeat(5_001));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toMatch(/5000/);
  });

  // 空文字 / 空白だけは NG
  it('rejects an empty / whitespace-only comment', () => {
    expect(commentBodySchema.safeParse('').success).toBe(false);
    expect(commentBodySchema.safeParse('   ').success).toBe(false);
  });
});

// エスカレーション理由スキーマ
describe('escalationReasonSchema', () => {
  // 1000 文字まで OK
  it('accepts 1,000 characters', () => {
    expect(escalationReasonSchema.safeParse('y'.repeat(1_000)).success).toBe(true);
  });

  // 1001 文字は NG
  it('rejects 1,001 characters', () => {
    const r = escalationReasonSchema.safeParse('y'.repeat(1_001));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toMatch(/1000/);
  });
});

// FAQ 候補入力スキーマ
describe('faqCandidateSchema', () => {
  // 質問/回答ともに 2000 文字まで OK
  it('accepts 2,000 characters in both question and answer', () => {
    const r = faqCandidateSchema.safeParse({
      question: 'q'.repeat(2_000),
      answer: 'a'.repeat(2_000),
    });
    expect(r.success).toBe(true);
  });

  // 質問 2001 文字は NG
  it('rejects a 2,001-character question', () => {
    const r = faqCandidateSchema.safeParse({ question: 'q'.repeat(2_001), answer: 'a' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toMatch(/2000/);
  });

  // 回答 2001 文字は NG
  it('rejects a 2,001-character answer', () => {
    const r = faqCandidateSchema.safeParse({ question: 'q', answer: 'a'.repeat(2_001) });
    expect(r.success).toBe(false);
  });
});
