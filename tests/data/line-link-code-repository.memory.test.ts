// LINE 連携コード冪等化記録リポジトリ (メモリアダプタ) の単体テスト。
// §4 Phase 2.1 フォローアップ (/code-review ultra 指摘対応): インプロセス Map から
// DB 永続化へ切り替えた冪等化記録の基本契約 (処理済み判定・記録・冪等な再記録) を検証する。

import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos } from '@/data/ports/unit-of-work';

let store: Store;
let repos: Repos;

beforeEach(() => {
  const ctx = createMemoryContext();
  store = ctx.store;
  repos = ctx.repos;
});

describe('LineLinkCodeRepository (memory)', () => {
  // 未記録の messageId は未処理として返る
  it('未記録のmessageIdは未処理と判定する', async () => {
    expect(await repos.lineLinkCodes.wasProcessed('msg-1')).toBe(false);
  });

  // 記録した messageId は処理済みと判定される
  it('記録したmessageIdは処理済みと判定する', async () => {
    await repos.lineLinkCodes.markProcessed('msg-1');
    expect(await repos.lineLinkCodes.wasProcessed('msg-1')).toBe(true);
  });

  // 同じ messageId を複数回記録しても冪等 (エラーにならず、記録は 1 件のまま)
  it('同じmessageIdを複数回記録しても冪等', async () => {
    await repos.lineLinkCodes.markProcessed('msg-1');
    await repos.lineLinkCodes.markProcessed('msg-1');
    expect(store.lineLinkCodeRefs.size).toBe(1);
  });

  // 別の messageId は互いに影響しない
  it('別のmessageIdには影響しない', async () => {
    await repos.lineLinkCodes.markProcessed('msg-1');
    expect(await repos.lineLinkCodes.wasProcessed('msg-2')).toBe(false);
  });
});
