// Vitest のテスト DSL (describe=グループ, beforeAll/afterAll=前後処理)
import { describe, beforeAll, afterAll } from 'vitest';
// Prisma クライアント本体 (生成物。DB へ実際に接続して操作する SDK)
import { PrismaClient } from '@/generated/prisma';
// 本番 Prisma 実装の repos 束を組み立てる関数
import { buildPrismaRepos } from '@/data/adapters/prisma';
// 共通契約テストとそのコンテキスト型 (memory 版と同じものを使い回す)
import {
  runInvitationRepositoryContract,
  type InvitationContractContext,
} from './invitation-repository.contract';

// テナント A の ID (契約テストの既定テナント)
const TENANT_A = 'default-tenant';
// クロステナント回帰テスト用のテナント B の ID
const TENANT_B = 'tenant-b';

// この DB 依存テストを実行してよいかどうかの明示フラグ (CI の専用ジョブだけが '1' を立てる)
// DATABASE_URL の有無で判定すると、開発者の dev DB を誤って TRUNCATE しかねないため専用フラグにする
const SHOULD_RUN = process.env.RUN_PRISMA_CONTRACT === '1';

// Prisma 実装が InvitationRepository 契約を満たすか検証する (フラグが立っているときだけ走る)
describe.runIf(SHOULD_RUN)('prisma adapter', () => {
  // beforeAll で生成する PrismaClient を後続のヘルパーから参照するための変数
  let prisma: PrismaClient;

  // スイート開始時に 1 度だけ DB へ接続する
  beforeAll(async () => {
    // PrismaClient を生成 (接続先は環境変数 DATABASE_URL から読まれる)
    prisma = new PrismaClient();
    // 実際に DB へ接続を張る (失敗時はここで早期に分かる)
    await prisma.$connect();
  });

  // スイート終了時に接続を確実に閉じる (接続リークを防ぐ)
  afterAll(async () => {
    // PrismaClient を破棄して接続を解放する
    await prisma.$disconnect();
  });

  // 全テーブルを空にしてテスト間の状態を完全に独立させる
  async function resetDatabase() {
    // 子テーブル → 親テーブルの順序は CASCADE が吸収する。テーブル名はモデル名と同一 (PascalCase)
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Attachment","TicketHistory","TicketComment","Notification","FaqCandidate","Ticket","Category","Invitation","MagicLinkToken","User","Tenant" RESTART IDENTITY CASCADE',
    );
  }

  // Prisma 実装向けに InvitationContractContext を組み立てる (契約の beforeEach から毎回呼ばれる)
  async function makePrismaContext(): Promise<InvitationContractContext> {
    // まず DB を空にして、このテスト専用のまっさらな状態を作る
    await resetDatabase();

    // 本番と同じ組み立て関数で repos 束を生成する
    const repos = buildPrismaRepos(prisma);

    // テナント A / B を用意するシード
    const seedTwoTenants: InvitationContractContext['seedTwoTenants'] = async () => {
      // テナント A / B を作成する (mode は lite で十分)
      await prisma.tenant.create({ data: { id: TENANT_A, name: 'デフォルト組織', mode: 'lite' } });
      await prisma.tenant.create({ data: { id: TENANT_B, name: '別組織', mode: 'lite' } });
      // テスト本体が使うテナント ID を返す
      return { tenantA: TENANT_A, tenantB: TENANT_B };
    };

    // 組み立てた repos とシード関数を契約コンテキストとして返す
    return { repo: repos.invitations, seedTwoTenants };
  }

  // memory 版と同一の契約スイートを Prisma 実装に対して実行する
  runInvitationRepositoryContract(makePrismaContext);
});
