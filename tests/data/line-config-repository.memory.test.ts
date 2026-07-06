// LINE 連携設定リポジトリ (メモリアダプタ) の単体テスト。
// upsert / findByTenant / findByBotUserId / delete が正しく動き、テナント境界を越えないことを確認する。
// docs/smb-dx-pivot-plan.md §4 Phase 2.1。

// Vitest の DSL とフック
import { beforeEach, describe, expect, it } from 'vitest';
// メモリ context (store/repos)
import { createMemoryContext } from '@/data/adapters/memory';
// 型のみ
import type { Repos } from '@/data/ports/unit-of-work';

// テスト用テナント識別子
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

// テストごとに作り直す repos
let repos: Repos;

// LINE 連携設定の入力サンプルを作るヘルパー
function sampleInput(tenantId: string, botUserId: string) {
  return {
    tenantId, // 所属テナント
    channelSecret: `secret-${tenantId}`, // Webhook 署名検証用シークレット
    channelAccessToken: `token-${tenantId}`, // Messaging API push 用アクセストークン
    botUserId, // このチャネルの Bot User ID
  };
}

// LINE 連携設定リポジトリの仕様確認テスト群
describe('LineConfigRepository (memory)', () => {
  // 各テストの前にメモリ context を作り直す
  beforeEach(() => {
    repos = createMemoryContext().repos;
  });

  // 未設定なら null を返す
  it('未設定のテナントは findByTenant が null を返す', async () => {
    expect(await repos.lineConfigs.findByTenant(TENANT_A)).toBeNull();
  });

  // 未登録の botUserId は findByBotUserId が null を返す
  it('未登録の botUserId は findByBotUserId が null を返す', async () => {
    expect(await repos.lineConfigs.findByBotUserId('Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeNull();
  });

  // upsert が新規作成し、findByTenant / findByBotUserId 両方で取得できる
  it('upsert で新規作成し findByTenant / findByBotUserId で取得できる', async () => {
    const botUserId = 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const created = await repos.lineConfigs.upsert(sampleInput(TENANT_A, botUserId));
    // 作成結果が入力どおりであること
    expect(created.tenantId).toBe(TENANT_A);
    expect(created.botUserId).toBe(botUserId);
    // tenantId からも botUserId からも同じ設定を取得できる
    const byTenant = await repos.lineConfigs.findByTenant(TENANT_A);
    expect(byTenant?.channelSecret).toBe(`secret-${TENANT_A}`);
    const byBotUserId = await repos.lineConfigs.findByBotUserId(botUserId);
    expect(byBotUserId?.tenantId).toBe(TENANT_A);
  });

  // 同一テナントへの upsert は新規作成ではなく更新になる (1 テナント 1 設定)
  it('同一テナントへの upsert は更新になる (重複作成しない)', async () => {
    const botUserId1 = 'Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const botUserId2 = 'Uddddddddddddddddddddddddddddddd1';
    // 1 回目: 作成
    const first = await repos.lineConfigs.upsert(sampleInput(TENANT_A, botUserId1));
    // 2 回目: botUserId 変更で更新
    const second = await repos.lineConfigs.upsert({
      ...sampleInput(TENANT_A, botUserId2),
      channelSecret: 'new-secret',
    });
    // ID は維持され (同一レコードの更新)、値だけ変わる
    expect(second.id).toBe(first.id);
    expect(second.botUserId).toBe(botUserId2);
    expect(second.channelSecret).toBe('new-secret');
    // 旧 botUserId ではもう引けない
    expect(await repos.lineConfigs.findByBotUserId(botUserId1)).toBeNull();
  });

  // 他テナントが既に使用している botUserId への upsert はエラーになる (クロステナント混線防止)
  it('他テナントが使用中の botUserId への upsert はエラーになる', async () => {
    const sharedBotUserId = 'Ueeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    await repos.lineConfigs.upsert(sampleInput(TENANT_A, sharedBotUserId));
    await expect(
      repos.lineConfigs.upsert(sampleInput(TENANT_B, sharedBotUserId)),
    ).rejects.toThrow();
  });

  // delete で設定が消える
  it('delete で設定を削除できる', async () => {
    const botUserId = 'Uffffffffffffffffffffffffffffffff';
    await repos.lineConfigs.upsert(sampleInput(TENANT_A, botUserId));
    await repos.lineConfigs.delete(TENANT_A);
    // 削除後は tenantId からも botUserId からも取得できない
    expect(await repos.lineConfigs.findByTenant(TENANT_A)).toBeNull();
    expect(await repos.lineConfigs.findByBotUserId(botUserId)).toBeNull();
  });

  // クロステナント分離: テナント A の設定はテナント B から見えない
  it('テナント A の設定はテナント B から取得できない (クロステナント分離)', async () => {
    const botUserId = 'Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab';
    // A にだけ設定を作る
    await repos.lineConfigs.upsert(sampleInput(TENANT_A, botUserId));
    // B からは取得できない
    expect(await repos.lineConfigs.findByTenant(TENANT_B)).toBeNull();
    // B の delete は A に影響しない
    await repos.lineConfigs.delete(TENANT_B);
    expect(await repos.lineConfigs.findByTenant(TENANT_A)).not.toBeNull();
  });
});
