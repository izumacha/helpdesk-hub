// UserRepository のメモリアダプタ単体テストで共有するフィクスチャヘルパー。
// /code-review ultra 指摘対応: 同一の putUser() 実装が user-line-link.memory.test.ts と
// user-repository.memory.test.ts に複製されていたため (CLAUDE.md §6)、ここに集約する。

import type { Store } from '@/data/adapters/memory';

// テスト用メンバーを 1 人ストアに置く小ヘルパー
export function putUser(
  store: Store, // 書き込み先のメモリストア
  id: string, // ユーザー ID
  tenantId: string, // 所属テナント ID
  extra: Record<string, unknown> = {}, // 上書きしたいフィールド (role/email/lineUserId 等)
): void {
  const now = new Date();
  store.users.set(id, {
    id,
    email: `${id}@example.com`,
    name: id,
    passwordHash: 'x',
    role: 'requester',
    tenantId,
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
}
