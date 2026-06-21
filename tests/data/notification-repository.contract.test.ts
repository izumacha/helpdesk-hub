// Vitest の describe (テストグループ) のみ使う
import { describe } from 'vitest';
// メモリ実装のリポジトリ束 + ストアを作成するファクトリ
import { createMemoryContext } from '@/data/adapters/memory';
// 共通契約テストとそのコンテキスト型
import {
  runNotificationRepositoryContract,
  type NotificationContractContext,
} from './notification-repository.contract';

// テナント A の ID (マルチテナント化後はあらゆる行で必須)
const TENANT_A = 'default-tenant';
// クロステナント回帰テスト用のテナント B の ID
const TENANT_B = 'tenant-b';

// メモリ実装向けに NotificationContractContext を組み立てる
function makeMemoryContext(): NotificationContractContext {
  // 純粋メモリ実装の store / repos を生成する
  const { store, repos } = createMemoryContext();

  // テナント A / B と、各テナントに 1 人ずつユーザーを用意するシード
  const seedTwoTenants: NotificationContractContext['seedTwoTenants'] = async () => {
    // 現在時刻 (作成日時に使う)
    const now = new Date();
    // 投入する 2 テナントの定義 (id, name)
    const tenantDefs: Array<[string, string]> = [
      [TENANT_A, 'デフォルト組織'],
      [TENANT_B, '別組織'],
    ];
    // 各テナントを store に直接書き込む (mode は lite で十分)
    for (const [id, name] of tenantDefs) {
      store.tenants.set(id, {
        id,
        name,
        mode: 'lite',
        industry: null,
        inboundToken: null, // メール取り込み未発行 (テスト用フィクスチャ)
      slackWebhookUrl: null, // Slack 通知未設定 (テスト用フィクスチャ)
        createdAt: now,
      });
    }
    // テナント A に属するユーザー ID
    const userAId = 'u-a-1';
    // テナント B に属するユーザー ID
    const userBId = 'u-b-1';
    // 投入するユーザーの定義 (id, 所属テナント ID)
    const userDefs: Array<[string, string]> = [
      [userAId, TENANT_A],
      [userBId, TENANT_B],
    ];
    // 各ユーザーを store に直接書き込む (リポジトリは User の create を持たないため)
    for (const [id, tenantId] of userDefs) {
      store.users.set(id, {
        id,
        email: `${id}@example.com`,
        name: id,
        passwordHash: 'x',
        role: 'requester',
        tenantId, // 必ずテナントスコープを付与する
        createdAt: now,
        updatedAt: now,
      });
    }
    // テスト本体が使うテナント ID / ユーザー ID を返す
    return { tenantA: TENANT_A, tenantB: TENANT_B, userAId, userBId };
  };

  // 検証対象の通知リポジトリとシード関数を文脈として返す
  return { repo: repos.notifications, seedTwoTenants };
}

// メモリアダプタが NotificationRepository 契約を満たしているかを実行する
describe('memory adapter', () => {
  runNotificationRepositoryContract(makeMemoryContext);
});
