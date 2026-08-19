// Prisma 7 で必須になったドライバアダプタ (node-postgres 版) をインポート
import { PrismaPg } from '@prisma/adapter-pg';
// 生成された Prisma クライアント本体と、ログ設定の型をインポート
import { Prisma, PrismaClient } from '@/generated/prisma';

/**
 * Builds a `PrismaClient` backed by the node-postgres driver adapter.
 *
 * Prisma 7 removed `datasource.url` from `schema.prisma`, so the connection
 * string is no longer picked up implicitly: every client must be constructed
 * with a driver adapter. Centralising that wiring here keeps the ~30 call sites
 * (app singleton, seed script, contract tests, E2E specs) from each repeating
 * the adapter setup — and from drifting apart when it changes.
 */
// PrismaClient を生成する共通ファクトリ (ログ設定だけ呼び出し側が指定できる)
export function createPrismaClient(options?: {
  // Prisma が出力するログの種類 (省略時は Prisma の既定に任せる)
  log?: (Prisma.LogLevel | Prisma.LogDefinition)[];
}): PrismaClient {
  // 接続文字列を環境変数から取り出す
  const connectionString = process.env.DATABASE_URL;

  // 接続文字列が無いまま進むと実行時まで気付けないので、ここで明示的に落とす (fail-closed)
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL が未設定です。Prisma 7 はドライバアダプタ経由で接続するため、接続文字列が必須です。',
    );
  }

  // Prisma 5 のクエリエンジンは接続文字列の ?schema= を解釈して search_path に反映していたが、
  // ドライバアダプタは URL のクエリ文字列を素通しするだけで解釈しない。取りこぼすと
  // 「public スキーマに黙って読み書きする」= 空の結果やテーブル二重作成になり、
  // エラーも出ないまま壊れるため、ここで取り出してアダプタの schema オプションへ渡す。
  const schema = new URL(connectionString).searchParams.get('schema') ?? undefined;

  // node-postgres のコネクションプールを内部に持つアダプタを組み立てる
  const adapter = new PrismaPg({ connectionString }, schema ? { schema } : undefined);

  // アダプタを渡して PrismaClient を生成し、呼び出し側へ返す
  return new PrismaClient({ adapter, ...(options?.log ? { log: options.log } : {}) });
}
