// isUniqueConstraintError (src/lib/prisma-errors.ts) の単体テスト。
// /code-review ultra 指摘対応 (2026-07-13): 6 箇所に重複していた「一意制約違反かどうか」の
// 判定ロジックを共通ヘルパーへ一元化した (§6 DRY)。各所での挙動 (本番 Prisma のエラー文言、
// memory アダプタの相当エラー、無関係なエラーの素通し) が変わっていないことを確認する。

import { describe, expect, it } from 'vitest';
import { isUniqueConstraintError } from '@/lib/prisma-errors';

describe('isUniqueConstraintError', () => {
  // Prisma 本番アダプタの一意制約違反メッセージ (P2002) を検出できる
  it('Prisma の "Unique constraint" 文言を検出する', () => {
    const err = new Error('Unique constraint failed on the fields: (`email`)');
    expect(isUniqueConstraintError(err)).toBe(true);
  });

  // メッセージに "P2002" コードだけが含まれる場合も検出できる
  it('"P2002" コードを検出する', () => {
    const err = new Error('Unique constraint failed on the fields: (`botUserId`) (P2002)');
    expect(isUniqueConstraintError(err)).toBe(true);
  });

  // memory アダプタ (location-repository.memory.ts 等) が模す "already exists" 文言を検出できる
  it('memory アダプタの "already exists" 文言を検出する', () => {
    const err = new Error('Location name "本社" already exists in tenant tenant-a');
    expect(isUniqueConstraintError(err)).toBe(true);
  });

  // 無関係なエラーは一意制約違反と誤検出しない
  it('無関係なエラーメッセージは false を返す', () => {
    const err = new Error('この招待リンクは無効か、既に使用されています。');
    expect(isUniqueConstraintError(err)).toBe(false);
  });

  // Error インスタンスでない値 (文字列 throw など) は判定不能として false を返す
  it('Error インスタンスでない値は false を返す', () => {
    expect(isUniqueConstraintError('文字列としての throw')).toBe(false);
    expect(isUniqueConstraintError(undefined)).toBe(false);
  });
});
