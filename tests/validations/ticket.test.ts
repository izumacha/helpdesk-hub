import { describe, expect, it } from 'vitest';
import {
  commentBodySchema,
  createTicketSchema,
  escalationReasonSchema,
} from '@/lib/validations/ticket';
import { faqCandidateSchema } from '@/lib/validations/faq';

describe('createTicketSchema', () => {
  const base = { title: 'タイトル', body: '内容', priority: 'Medium' as const };

  it('accepts a 10,000-character body', () => {
    const r = createTicketSchema.safeParse({ ...base, body: 'a'.repeat(10_000) });
    expect(r.success).toBe(true);
  });

  it('rejects a 10,001-character body with a Japanese message', () => {
    const r = createTicketSchema.safeParse({ ...base, body: 'a'.repeat(10_001) });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toMatch(/10000/);
    }
  });

  it('rejects a 201-character title', () => {
    const r = createTicketSchema.safeParse({ ...base, title: 'a'.repeat(201) });
    expect(r.success).toBe(false);
  });
});

describe('commentBodySchema', () => {
  it('accepts 5,000 characters', () => {
    expect(commentBodySchema.safeParse('x'.repeat(5_000)).success).toBe(true);
  });

  it('rejects 5,001 characters', () => {
    const r = commentBodySchema.safeParse('x'.repeat(5_001));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toMatch(/5000/);
  });

  it('rejects an empty / whitespace-only comment', () => {
    expect(commentBodySchema.safeParse('').success).toBe(false);
    expect(commentBodySchema.safeParse('   ').success).toBe(false);
  });
});

describe('escalationReasonSchema', () => {
  it('accepts 1,000 characters', () => {
    expect(escalationReasonSchema.safeParse('y'.repeat(1_000)).success).toBe(true);
  });

  it('rejects 1,001 characters', () => {
    const r = escalationReasonSchema.safeParse('y'.repeat(1_001));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toMatch(/1000/);
  });
});

describe('faqCandidateSchema', () => {
  it('accepts 2,000 characters in both question and answer', () => {
    const r = faqCandidateSchema.safeParse({
      question: 'q'.repeat(2_000),
      answer: 'a'.repeat(2_000),
    });
    expect(r.success).toBe(true);
  });

  it('rejects a 2,001-character question', () => {
    const r = faqCandidateSchema.safeParse({ question: 'q'.repeat(2_001), answer: 'a' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toMatch(/2000/);
  });

  it('rejects a 2,001-character answer', () => {
    const r = faqCandidateSchema.safeParse({ question: 'q', answer: 'a'.repeat(2_001) });
    expect(r.success).toBe(false);
  });
});
