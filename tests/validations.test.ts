// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';
// チケット作成入力の Zod スキーマ
import { createTicketSchema } from '../src/lib/validations/ticket';

// チケット作成 Zod スキーマの基本仕様確認
describe('createTicketSchema', () => {
  // 検証に通る最小限の正常系入力
  const valid = { title: 'テスト件名', body: '内容', priority: 'Medium' as const };

  // 正常系: 上記入力は検証成功
  it('accepts valid input', () => {
    const result = createTicketSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  // タイトル空文字は弾く
  it('rejects empty title', () => {
    const result = createTicketSchema.safeParse({ ...valid, title: '' });
    expect(result.success).toBe(false);
  });

  // タイトル 200 文字超は弾く
  it('rejects title over 200 characters', () => {
    const result = createTicketSchema.safeParse({ ...valid, title: 'a'.repeat(201) });
    expect(result.success).toBe(false);
  });

  // 本文空は弾く
  it('rejects empty body', () => {
    const result = createTicketSchema.safeParse({ ...valid, body: '' });
    expect(result.success).toBe(false);
  });

  // 列挙外の優先度は弾く
  it('rejects invalid priority', () => {
    const result = createTicketSchema.safeParse({ ...valid, priority: 'Critical' });
    expect(result.success).toBe(false);
  });

  // categoryId は空文字を undefined に正規化する
  it('normalizes empty categoryId to undefined', () => {
    const result = createTicketSchema.safeParse({ ...valid, categoryId: '' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.categoryId).toBeUndefined();
    }
  });

  // 値ありの categoryId はそのまま保持する
  it('preserves non-empty categoryId', () => {
    const result = createTicketSchema.safeParse({ ...valid, categoryId: 'cat-123' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.categoryId).toBe('cat-123');
    }
  });
});
