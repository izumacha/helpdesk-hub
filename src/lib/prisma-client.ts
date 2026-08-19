// Prisma 7 で必須になったドライバアダプタ (node-postgres 版) をインポート
import { PrismaPg } from '@prisma/adapter-pg';
// 生成された Prisma クライアント本体と、ログ設定の型をインポート
import { Prisma, PrismaClient } from '@/generated/prisma';

// Postgres の識別子として安全に扱える形 (先頭は英字か _、以降は英数字 / _ / $)。
// search_path はプレースホルダを使えず文字列として組み立てるしかないため、
// この形に一致しない値は受け付けない (引用符やスペースを混ぜた注入を防ぐ)。
const SAFE_SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Reads the Prisma-specific `?schema=` parameter out of the connection string.
 *
 * Parsing is guarded because `new URL()` throws a `TypeError` whose `input`
 * property carries the whole DSN — password included — so letting it escape
 * would leak the credential into any log that inspects the error.
 */
// 接続文字列から ?schema= を取り出す (壊れた URL は資格情報を伏せて落とす)
function readSchemaFromConnectionString(connectionString: string): string | undefined {
  // URL として解釈を試みる
  try {
    // クエリ文字列から schema パラメータを取り出す (無ければ undefined)
    return new URL(connectionString).searchParams.get('schema') ?? undefined;
  } catch {
    // 元の TypeError は input プロパティに DSN 全体 (パスワード込み) を載せるため、
    // そのまま投げるとログに資格情報が残る。文脈だけを伝える例外に差し替える。
    throw new Error(
      'DATABASE_URL を URL として解釈できません。postgresql://... 形式で指定してください (値はログに出しません)。',
    );
  }
}

/**
 * Builds the libpq `options` string that pins the session's `search_path`.
 *
 * The adapter's `schema` option only qualifies Prisma-generated queries. Raw
 * SQL (`$queryRaw` / `$executeRawUnsafe`, used by the dashboard metrics query
 * and the contract tests' TRUNCATE) still resolves through `search_path`, so
 * without this the two halves would silently target different schemas.
 */
// search_path を接続時に固定するための libpq オプション文字列を組み立てる
function buildSearchPathOption(schema: string): string {
  // 識別子として安全でない名前は組み立てず、その場で落とす (fail-closed)
  if (!SAFE_SCHEMA_NAME.test(schema)) {
    throw new Error(
      'DATABASE_URL の ?schema= に使える文字は英数字・アンダースコア・$ のみです (先頭は英字かアンダースコア)。',
    );
  }
  // 接続確立時に実行される設定として search_path を渡す
  return `-c search_path=${schema}`;
}

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
  const schema = readSchemaFromConnectionString(connectionString);

  // node-postgres のコネクションプールを内部に持つアダプタを組み立てる。
  // schema 指定があるときは接続時の search_path も同じスキーマへ向ける (下の関数の説明を参照)。
  const adapter = new PrismaPg(
    { connectionString, ...(schema ? { options: buildSearchPathOption(schema) } : {}) },
    schema ? { schema } : undefined,
  );

  // アダプタを渡して PrismaClient を生成し、呼び出し側へ返す
  return new PrismaClient({ adapter, ...(options?.log ? { log: options.log } : {}) });
}
