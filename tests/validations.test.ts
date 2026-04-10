import { describe, expect, it } from 'vitest';
import { createTicketSchema } from '../src/lib/validations/ticket';

describe('createTicketSchema', () => {
  const valid = { title: 'テスト件名', body: '内容', priority: 'Medium' as const };

  it('accepts valid input', () => {
    const result = createTicketSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('rejects empty title', () => {
    const result = createTicketSchema.safeParse({ ...valid, title: '' });
    expect(result.success).toBe(false);
  });

  it('rejects title over 200 characters', () => {
    const result = createTicketSchema.safeParse({ ...valid, title: 'a'.repeat(201) });
    expect(result.success).toBe(false);
  });

  it('rejects empty body', () => {
    const result = createTicketSchema.safeParse({ ...valid, body: '' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid priority', () => {
    const result = createTicketSchema.safeParse({ ...valid, priority: 'Critical' });
    expect(result.success).toBe(false);
  });

  it('normalizes empty categoryId to undefined', () => {
    const result = createTicketSchema.safeParse({ ...valid, categoryId: '' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.categoryId).toBeUndefined();
    }
  });

  it('preserves non-empty categoryId', () => {
    const result = createTicketSchema.safeParse({ ...valid, categoryId: 'cat-123' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.categoryId).toBe('cat-123');
    }
  });
});
