// 認証イベント監査ログリポジトリ (メモリアダプタ) の単体テスト。
// 課題棚卸し (2026-07-26) の否認防止ギャップ対応で新設した記録専用リポジトリ。
// record が入力どおりの行をストアへ追記することを検証する。

import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos } from '@/data/ports/unit-of-work';
import type { AuthAuditEvent } from '@/domain/types';

let store: Store;
let repos: Repos;

describe('AuthAuditLogRepository (memory)', () => {
  beforeEach(() => {
    // テストごとに空ストア + repos 一式を作り直す (テスト間の独立性を保つ)
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
  });

  // record した行がストアに追記されること
  it('records an auth event with the given identity', async () => {
    // ログイン成功イベントを 1 件記録する
    await repos.authAudit.record({
      event: 'password_login_success',
      email: 'agent@example.com',
      userId: 'u1',
      tenantId: 't1',
    });

    // ストアの中身を配列にして検証する
    const rows = [...store.authAuditLogs.values()];
    expect(rows).toHaveLength(1);
    // 入力どおりの値で保存されている
    expect(rows[0]).toMatchObject({
      event: 'password_login_success',
      email: 'agent@example.com',
      userId: 'u1',
      tenantId: 't1',
    });
    // 記録日時が Date として付与されている
    expect(rows[0].createdAt).toBeInstanceOf(Date);
  });

  // 不在ユーザーへの失敗イベントは userId/tenantId が null のまま記録できること
  it('records a failure event with null identity for an unknown email', async () => {
    // 不在メールへの失敗イベントを記録する
    await repos.authAudit.record({
      event: 'password_login_failure',
      email: 'ghost@example.com',
      userId: null,
      tenantId: null,
    });

    // null の識別子がそのまま保持されている
    const rows = [...store.authAuditLogs.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBeNull();
    expect(rows[0].tenantId).toBeNull();
  });

  // 全イベント種別が記録できること (domain 型と実装の同期漏れ検知)
  it('accepts every AuthAuditEvent value', async () => {
    // 定義済みの全イベント種別を列挙する
    const events: AuthAuditEvent[] = [
      'password_login_success',
      'password_login_failure',
      'magic_link_login_success',
      'sso_login_success',
      'sso_assertion_accepted',
    ];
    // 1 種別ずつ記録する
    for (const event of events) {
      await repos.authAudit.record({
        event,
        email: 'agent@example.com',
        userId: 'u1',
        tenantId: 't1',
      });
    }
    // 全種別が 1 件ずつ追記されている
    expect(store.authAuditLogs.size).toBe(events.length);
    const stored = new Set([...store.authAuditLogs.values()].map((r) => r.event));
    expect(stored).toEqual(new Set(events));
  });
});
