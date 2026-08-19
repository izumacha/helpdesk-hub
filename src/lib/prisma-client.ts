// Prisma 7 で必須になったドライバアダプタ (node-postgres 版) をインポート
import { PrismaPg } from '@prisma/adapter-pg';
// 生成された Prisma クライアント本体と、ログ設定の型をインポート
import { Prisma, PrismaClient } from '@/generated/prisma';
// 接続時に search_path を固定する libpq オプションの組み立て (純粋関数)
import { buildSearchPathOption } from './pg-search-path';

// `?schema=` が書かれていないときに使うスキーマ。
// Prisma 5 のクエリエンジンは接続時に search_path をここへ固定していた。Prisma 7 の
// ドライバアダプタは何もしないため、そのままだと **ORM は public を、生 SQL はサーバ/ロール
// 側の search_path を**向く (`ALTER DATABASE ... SET search_path` を使う構成で実際に分かれる。
// 実測: 生 SQL の INSERT が別スキーマに入り、ORM から読めなくなる)。既定値を明示して両者を揃える。
const DEFAULT_SCHEMA = 'public';

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
 * Reads Prisma 5's `?connection_limit=` and maps it to node-postgres's `max`.
 *
 * The query engine used to size its pool from that parameter; the driver
 * adapter ignores it and node-postgres defaults to 10. Without this, upgrading
 * a deployment whose DSN carries `connection_limit=2` silently opens five times
 * as many connections, and the DSN offers no way back.
 */
// 接続文字列の connection_limit をプール上限 (node-postgres の max) へ読み替える
function readPoolMax(url: URL): number | undefined {
  // パラメータを取り出す (無ければ既定のままにする)
  const raw = url.searchParams.get('connection_limit');
  if (raw === null) return undefined;
  // 数値として解釈する
  const parsed = Number(raw);
  // 1 以上の整数でなければ設定ミスなので、黙って既定へ倒さず落とす (fail-closed)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('DATABASE_URL の ?connection_limit= には 1 以上の整数を指定してください。');
  }
  // プール 1 本あたりの最大接続数として返す
  return parsed;
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
  // 「ORM と生 SQL が別スキーマを向く」= 空の結果やテーブル二重作成になり、
  // エラーも出ないまま壊れるため、ここで取り出して両方へ反映する。
  // **未指定は public を明示する**(DEFAULT_SCHEMA)。**空文字は未指定と区別して弾く**:
  // `?schema=` と書かれた (値だけ空の) 状態を既定値へ倒すと、テンプレートの変数が
  // 空のまま展開された事故に気付けない。空文字は buildSearchPathOption が落とす (fail-closed)。
  const schema = url.searchParams.get('schema') ?? DEFAULT_SCHEMA;

  // node-postgres のコネクションプールを内部に持つアダプタを組み立てる。
  // Prisma が組み立てるクエリは schema オプションで、生 SQL は接続時の search_path で
  // 同じスキーマへ向ける (片方だけだと両者が食い違う。詳細は pg-search-path.ts)。
  // プール上限は DSN の connection_limit を尊重する (未指定なら node-postgres の既定 10)
  const poolMax = readPoolMax(url);

  const adapter = new PrismaPg(
    {
      ...buildScopedConnectionConfig(connectionString, url, schema),
      ...(poolMax === undefined ? {} : { max: poolMax }),
    },
    {
      schema,
      // プールや待機中コネクションのエラーを握り潰さない (既定では debug 出力に消える)。
      // DB の再起動・フェイルオーバー時に何も残らないと調査ができなくなるため、
      // 接続文字列を含まない安全なメッセージだけをログに残す (CLAUDE.md §6 / §9)
      onPoolError: (error: Error) => console.error('[prisma] 接続プールでエラー:', error.message),
      onConnectionError: (error: Error) =>
        console.error('[prisma] コネクションでエラー:', error.message),
    },
  );

  // アダプタを渡して PrismaClient を生成し、呼び出し側へ返す
  return new PrismaClient({ adapter, ...(options?.log ? { log: options.log } : {}) });
}
