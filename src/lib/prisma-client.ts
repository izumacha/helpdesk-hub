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

// Prisma 5 のクエリエンジンが持っていた既定の待ち時間 (秒)。
// node-postgres は既定で「無期限に待つ」ため、そのままだとプール枯渇や DB 到達不能が
// エラーではなく**ハング**になる (リクエストが返らない)。同じ既定値を引き継ぐ。
const DEFAULT_POOL_TIMEOUT_SECONDS = 10;

/**
 * Reads the pool knobs Prisma 5 took from the DSN and maps them onto
 * node-postgres's config.
 *
 * The query engine sized its pool from `connection_limit` and bounded waits
 * with `pool_timeout` / `connect_timeout`; the driver adapter reads none of
 * them (`pg-connection-string` keeps them as inert keys), and node-postgres
 * defaults to 10 connections and **no timeout at all**. Left unmapped, a busy
 * or unreachable database turns request handling into an indefinite wait — the
 * failure mode `src/lib/prisma.ts` warns about for the `jwt` callback.
 */
// 接続文字列のプール関連パラメータを node-postgres の設定へ読み替える
function buildPoolTuning(url: URL): { max?: number; connectionTimeoutMillis: number } {
  // 1 以上の整数を取り出す共通処理 (不正値は黙って既定へ倒さず落とす: fail-closed)
  const readPositiveInt = (name: string, allowZero: boolean): number | undefined => {
    // パラメータを取り出す (無ければ未指定として扱う)
    const raw = url.searchParams.get(name);
    if (raw === null) return undefined;
    // 数値として解釈する
    const parsed = Number(raw);
    // 整数かつ許容範囲内であることを確かめる (0 の可否はパラメータによって違う)
    if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
      throw new Error(
        `DATABASE_URL の ?${name}= には ${allowZero ? '0 以上' : '1 以上'}の整数を指定してください。`,
      );
    }
    // 妥当な値を返す
    return parsed;
  };

  // プール 1 本あたりの最大接続数 (未指定なら node-postgres の既定 10 のまま)
  const max = readPositiveInt('connection_limit', false);
  // 空きコネクション待ちの上限 (秒)。Prisma と同じく 0 は「待ち続ける」を意味する
  const poolTimeout = readPositiveInt('pool_timeout', true);
  // 接続確立の上限 (秒)。node-postgres は待ち時間の設定口が 1 つなので、
  // pool_timeout が無いときの代わりとして使う
  const connectTimeout = readPositiveInt('connect_timeout', true);
  // 使う秒数を決める (指定が無ければ Prisma 5 の既定と同じ 10 秒)
  const timeoutSeconds = poolTimeout ?? connectTimeout ?? DEFAULT_POOL_TIMEOUT_SECONDS;

  // node-postgres 向けの設定として返す (0 はそのまま渡すと「無期限」になる)
  return {
    ...(max === undefined ? {} : { max }),
    connectionTimeoutMillis: timeoutSeconds * 1000,
  };
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
  const requestedSchema = url.searchParams.get('schema');
  // 実際に使うスキーマ (未指定なら public)
  const schema = requestedSchema ?? DEFAULT_SCHEMA;

  // **運用側が DSN の options で search_path を明示している場合の逃げ道**。
  // 既定の public 固定は「ORM と生 SQL が食い違わない」ための安全策だが、
  // 拡張機能を別スキーマに置くマネージド Postgres (Supabase の extensions など) では
  // `-c search_path=public,extensions` のような指定を消してはいけない。
  // `?schema=` を書いていない = スキーマの主張が無い場合に限り、DSN の指定を尊重する
  // (`?schema=` が書かれていれば、そちらが唯一の主張なので従来どおり後勝ちで固定する)。
  const dsnPinsSearchPath =
    requestedSchema === null &&
    /(^|\s)-c\s*search_path=/.test(url.searchParams.get('options') ?? '');

  // node-postgres のコネクションプールを内部に持つアダプタを組み立てる。
  // Prisma が組み立てるクエリは schema オプションで、生 SQL は接続時の search_path で
  // 同じスキーマへ向ける (片方だけだと両者が食い違う。詳細は pg-search-path.ts)。
  // プール上限と待ち時間は DSN の connection_limit / pool_timeout / connect_timeout を尊重する
  const poolTuning = buildPoolTuning(url);

  const adapter = new PrismaPg(
    {
      // DSN が自前で search_path を指定しているときは接続文字列をそのまま使う (上の逃げ道)
      ...(dsnPinsSearchPath
        ? { connectionString }
        : buildScopedConnectionConfig(connectionString, url, schema)),
      ...poolTuning,
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
