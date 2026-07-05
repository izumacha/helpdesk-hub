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

  // 空白だけのタイトル/本文は trim 後に空文字となり拒否される (見た目が空白のチケット作成を防ぐ)
  it('rejects a whitespace-only title', () => {
    const r = createTicketSchema.safeParse({ ...base, title: '   ' });
    expect(r.success).toBe(false);
  });
  it('rejects a whitespace-only body', () => {
    const r = createTicketSchema.safeParse({ ...base, body: '   ' });
    expect(r.success).toBe(false);
  });

  // 前後の空白は trim され、保存値には含まれない
  it('trims leading/trailing whitespace from title and body', () => {
    const r = createTicketSchema.safeParse({ ...base, title: '  タイトル  ', body: '  内容  ' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.title).toBe('タイトル');
      expect(r.data.body).toBe('内容');
    }
  });

  // dueDate 省略時は undefined に正規化されて通る (Lite フォームで未入力のケース)
  it('accepts input without dueDate', () => {
    const r = createTicketSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.dueDate).toBeUndefined();
  });

  // dueDate に空文字が来ても undefined 扱いで通る (HTML <input type="date"> が空のとき)
  it('treats empty-string dueDate as undefined', () => {
    const r = createTicketSchema.safeParse({ ...base, dueDate: '' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.dueDate).toBeUndefined();
  });

  // 正しい YYYY-MM-DD は受理し、文字列として保持する
  it('accepts a valid YYYY-MM-DD dueDate', () => {
    const r = createTicketSchema.safeParse({ ...base, dueDate: '2026-12-31' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.dueDate).toBe('2026-12-31');
  });

  // 形式不正 (区切りが違う) は拒否し、メッセージで形式を示唆する
  it('rejects a malformed dueDate', () => {
    const r = createTicketSchema.safeParse({ ...base, dueDate: '2026/12/31' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toMatch(/期限日/);
  });

  // 実在しない日付 (2 月 31 日) は拒否する
  it('rejects an impossible calendar date', () => {
    const r = createTicketSchema.safeParse({ ...base, dueDate: '2026-02-31' });
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
