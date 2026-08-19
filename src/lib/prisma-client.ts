// Prisma 7 で必須になったドライバアダプタ (node-postgres 版) をインポート
import { PrismaPg } from '@prisma/adapter-pg';
// 生成された Prisma クライアント本体と、ログ設定の型をインポート
import { Prisma, PrismaClient } from '@/generated/prisma';
// 接続時に search_path を固定する libpq オプションの組み立て (純粋関数)
import { buildSearchPathOption } from './pg-search-path';

/**
 * Parses the DSN.
 *
 * Guarded because `new URL()` throws a `TypeError` whose `input` property
 * carries the whole DSN — password included — so letting it escape would leak
 * the credential into any log that inspects the error.
 */
// 接続文字列を URL として解釈する (壊れた URL は資格情報を伏せて落とす)
function parseConnectionString(connectionString: string): URL {
  // URL として解釈を試みる
  try {
    // 解釈できたらそのまま返す
    return new URL(connectionString);
  } catch {
    // 元の TypeError は input プロパティに DSN 全体 (パスワード込み) を載せるため、
    // そのまま投げるとログに資格情報が残る。文脈だけを伝える例外に差し替える。
    throw new Error(
      'DATABASE_URL を URL として解釈できません。postgresql://... 形式で指定してください (値はログに出しません)。',
    );
  }
}

/**
 * Builds the node-postgres config for a DSN that names a schema.
 *
 * The `options` startup parameter has to be handed to the driver explicitly,
 * but node-postgres applies whatever the DSN carries *on top of* the config
 * object (`Object.assign({}, config, parse(connectionString))`). So when the
 * DSN already has `options=` — e.g. Neon's `?options=endpoint%3D<id>` — that
 * value would silently replace the `search_path` pinning and put raw SQL back
 * on a different schema than the ORM. Merging both, with `search_path` last so
 * it wins, and dropping `options` from the DSN keeps the outcome deterministic.
 */
// schema 指定つき DSN 用の接続設定を組み立てる (DSN 側の options と併存させる)
function buildScopedConnectionConfig(
  connectionString: string,
  url: URL,
  schema: string,
): { connectionString: string; options: string } {
  // search_path を固定する接続時オプションを作る (空のスキーマ名はここで弾かれる)
  const searchPathOption = buildSearchPathOption(schema);
  // DSN が独自の options を持っているか調べる
  const dsnOptions = url.searchParams.get('options');
  // 持っていなければ、接続文字列はそのまま使い options だけを足す (再エンコードを避ける)
  if (dsnOptions === null) return { connectionString, options: searchPathOption };
  // 持っている場合は、後勝ちで上書きされないよう DSN 側から options を取り除く
  const withoutOptions = new URL(url);
  withoutOptions.searchParams.delete('options');
  // DSN の指定を活かしつつ、search_path は後ろに置いて必ず効かせる
  return {
    connectionString: withoutOptions.toString(),
    options: `${dsnOptions} ${searchPathOption}`,
  };
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

  // 接続文字列を 1 度だけ解釈する (schema と options の両方をここから取り出す)
  const url = parseConnectionString(connectionString);

  // Prisma 5 のクエリエンジンは接続文字列の ?schema= を解釈して search_path に反映していたが、
  // ドライバアダプタは URL のクエリ文字列を素通しするだけで解釈しない。取りこぼすと
  // 「public スキーマに黙って読み書きする」= 空の結果やテーブル二重作成になり、
  // エラーも出ないまま壊れるため、ここで取り出してアダプタの schema オプションへ渡す。
  // **null と空文字を区別する**: `?schema=` と書かれた (値だけ空の) 状態を「未指定」と
  // 同じ扱いにすると、テンプレートの変数が空のまま展開されたときに黙って public を
  // 読み書きしてしまう。空文字はこの後 buildSearchPathOption が弾く (fail-closed)。
  const schema = url.searchParams.get('schema');

  // node-postgres のコネクションプールを内部に持つアダプタを組み立てる。
  // schema 指定があるときは接続時の search_path も同じスキーマへ向ける
  // (アダプタの schema オプションは Prisma が組み立てるクエリしか修飾せず、
  //  生 SQL は search_path で解決されるため。詳細は pg-search-path.ts)。
  const adapter = new PrismaPg(
    schema === null
      ? { connectionString }
      : buildScopedConnectionConfig(connectionString, url, schema),
    schema === null ? undefined : { schema },
  );

  // アダプタを渡して PrismaClient を生成し、呼び出し側へ返す
  return new PrismaClient({ adapter, ...(options?.log ? { log: options.log } : {}) });
}
