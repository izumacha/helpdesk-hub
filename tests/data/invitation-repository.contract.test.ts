// Vitest の describe (テストグループ) のみ使う
import { describe } from 'vitest';
// メモリ実装のリポジトリ束 + ストアを作成するファクトリ
import { createMemoryContext } from '@/data/adapters/memory';
// 共通契約テストとそのコンテキスト型
import {
  runInvitationRepositoryContract,
  type InvitationContractContext,
} from './invitation-repository.contract';

// テナント A の ID (マルチテナント化後はあらゆる行で必須)
const TENANT_A = 'default-tenant';
// クロステナント回帰テスト用のテナント B の ID
const TENANT_B = 'tenant-b';

// メモリ実装向けに InvitationContractContext を組み立てる
function makeMemoryContext(): InvitationContractContext {
  // 純粋メモリ実装の store / repos を生成する
  const { store, repos } = createMemoryContext();

  // テナント A / B を用意するシード
  const seedTwoTenants: InvitationContractContext['seedTwoTenants'] = async () => {
    // 現在時刻 (作成日時に使う)
    const now = new Date();
    // 投入する 2 テナントの定義 (id, name)
    const tenantDefs: Array<[string, string]> = [
      [TENANT_A, 'デフォルト組織'],
      [TENANT_B, '別組織'],
    ];
    // 各テナントを store に直接書き込む (mode は lite で十分)
    for (const [id, name] of tenantDefs) {
      store.tenants.set(id, { id, name, mode: 'lite', industry: null, inboundToken: null, createdAt: now });
    }
    // テスト本体が使うテナント ID を返す
    return { tenantA: TENANT_A, tenantB: TENANT_B };
  };

  // 検証対象の招待リポジトリとシード関数を文脈として返す
  return { repo: repos.invitations, seedTwoTenants };
}

// メモリアダプタが InvitationRepository 契約を満たしているかを実行する
describe('memory adapter', () => {
  runInvitationRepositoryContract(makeMemoryContext);
});
