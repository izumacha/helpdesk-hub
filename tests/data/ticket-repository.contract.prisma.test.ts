// Vitest のテスト DSL (describe=グループ, beforeAll/afterAll=前後処理)
import { describe, beforeAll, afterAll } from 'vitest';
// Prisma クライアント本体 (生成物。DB へ実際に接続して操作する SDK)
import { PrismaClient } from '@/generated/prisma';
// 本番 Prisma 実装の repos 束 / UnitOfWork を組み立てる関数
import { buildPrismaRepos, buildPrismaUow } from '@/data/adapters/prisma';
// ドメインのユーザー型 (シードの戻り値を整形する先)
import type { User, Role } from '@/domain/types';
// 共通契約テストとそのコンテキスト型 (memory 版と同じものを使い回す)
import { runTicketRepositoryContract, type ContractContext } from './ticket-repository.contract';

// 既定で使うテナント ID (契約テストは単一テナント前提で書かれている)
const TENANT_ID = 'default-tenant';
// クロステナント回帰テスト用のもう 1 つのテナント ID
const SECOND_TENANT_ID = 'tenant-b';

// この DB 依存テストを実行してよいかどうかの明示フラグ (CI の専用ジョブだけが '1' を立てる)
// DATABASE_URL の有無で判定すると、開発者の dev DB を誤って TRUNCATE しかねないため専用フラグにする
const SHOULD_RUN = process.env.RUN_PRISMA_CONTRACT === '1';

// Prisma 実装が TicketRepository 契約を満たすか検証する (フラグが立っているときだけ走る)
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
      'TRUNCATE TABLE "Attachment","TicketHistory","TicketComment","Notification","FaqCandidate","Ticket","Category","MagicLinkToken","User","Tenant" RESTART IDENTITY CASCADE',
    );
  }

  // Prisma の行を、契約テストが期待するドメイン User 型へ整形する
  function toDomainUser(row: {
    id: string;
    email: string;
    name: string;
    passwordHash: string;
    role: Role;
    tenantId: string;
    createdAt: Date;
    updatedAt: Date;
  }): User {
    // 必要なフィールドだけを取り出して返す (リレーション等は含めない)
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      passwordHash: row.passwordHash,
      role: row.role,
      tenantId: row.tenantId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // Prisma 実装向けに ContractContext を組み立てる (契約の beforeEach から毎回呼ばれる)
  async function makePrismaContext(): Promise<ContractContext> {
    // まず DB を空にして、このテスト専用のまっさらな状態を作る
    await resetDatabase();

    // 本番と同じ組み立て関数で repos 束と UnitOfWork を生成する
    const repos = buildPrismaRepos(prisma);
    const uow = buildPrismaUow(prisma);

    // 各テストで呼ばれる最小シード: 1 テナント + 1 依頼者 + 2 エージェント + 1 カテゴリ
    const seedBasicFixture: ContractContext['seedBasicFixture'] = async () => {
      // FK 先として必要なデフォルトテナントを投入する
      await prisma.tenant.create({
        data: { id: TENANT_ID, name: 'デフォルト組織', mode: 'lite' },
      });
      // 投入するユーザーの定義 (id, role, name) — memory 版と同じ ID/メールに揃える
      const userDefs: Array<[string, Role, string]> = [
        ['u-req-1', 'requester', '山田 太郎'],
        ['u-agt-1', 'agent', '佐藤 一郎'],
        ['u-agt-2', 'agent', '鈴木 二郎'],
      ];
      // 各ユーザーを作成し、戻り値 (ドメイン User) を ID 引きできるよう Map に溜める
      const created = new Map<string, User>();
      // ユーザー定義を 1 件ずつ DB に作成する
      for (const [id, role, name] of userDefs) {
        // Prisma でユーザー行を作成する (passwordHash はテスト用ダミー)
        const row = await prisma.user.create({
          data: {
            id,
            email: `${id}@example.com`,
            name,
            passwordHash: 'x',
            role,
            tenantId: TENANT_ID,
          },
        });
        // 作成結果をドメイン User へ整形して Map に保存する
        created.set(id, toDomainUser(row));
      }
      // 1 件だけカテゴリを投入する (このテナントに所属)
      await prisma.category.create({
        data: { id: 'cat-1', name: 'アカウント', tenantId: TENANT_ID },
      });
      // テスト本体が使う依頼者 / 2 エージェント / カテゴリ ID を返す
      return {
        requester: created.get('u-req-1')!,
        agentA: created.get('u-agt-1')!,
        agentB: created.get('u-agt-2')!,
        categoryId: 'cat-1',
      };
    };

    // クロステナント回帰テスト用に、もう 1 つのテナントを丸ごと用意する
    const seedSecondTenant: ContractContext['seedSecondTenant'] = async () => {
      // テナント B を投入する (mode は lite で十分)
      await prisma.tenant.create({
        data: { id: SECOND_TENANT_ID, name: '別組織', mode: 'lite' },
      });
      // テナント B 専属の依頼者ユーザーを 1 名作成する
      const requesterId = 'u-b-req-1';
      // Prisma でテナント B の依頼者を作成する
      const row = await prisma.user.create({
        data: {
          id: requesterId,
          email: `${requesterId}@example.com`,
          name: '田中 一郎',
          passwordHash: 'x',
          role: 'requester',
          tenantId: SECOND_TENANT_ID,
        },
      });
      // テナント B 専属のカテゴリも 1 件作成する
      const categoryId = 'cat-b-1';
      // Prisma でテナント B のカテゴリを作成する
      await prisma.category.create({
        data: { id: categoryId, name: '別組織カテゴリ', tenantId: SECOND_TENANT_ID },
      });
      // クロステナント検証用の最小セット (テナント ID / 依頼者 / カテゴリ ID) を返す
      return {
        tenantId: SECOND_TENANT_ID,
        requester: toDomainUser(row),
        categoryId,
      };
    };

    // 組み立てた repos / uow / シード関数を ContractContext として返す
    return { repos, uow, seedBasicFixture, seedSecondTenant };
  }

  // memory 版と同一の契約スイートを Prisma 実装に対して実行する
  runTicketRepositoryContract(makePrismaContext);
});
