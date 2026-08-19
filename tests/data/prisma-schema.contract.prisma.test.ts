// 接続文字列の `?schema=` が「Prisma が組み立てるクエリ」と「生 SQL」の両方へ効くことを、
// 実 PostgreSQL に対して確かめる契約テスト。
//
// 監査で発見したギャップ (Prisma 7 移行): ドライバアダプタは接続文字列の `?schema=` を
// 解釈しない。アダプタの schema オプションを渡すと Prisma が組み立てるクエリは修飾されるが、
// 生 SQL ($queryRaw / $executeRawUnsafe) は接続の search_path で解決されるため、
// 片方だけ直すと **ORM と生 SQL が別スキーマを向く**。エラーにならず「空の結果」や
// 「別スキーマへの書き込み」になる静かな壊れ方なので、実 DB で関係を直接固定する。
//
// スキーマ名の引用規則そのもの (純粋な組み立て) は tests/pg-search-path.test.ts が持つ。
// ここでは PostgreSQL が実際にどう解釈したかだけを見る。
//
// この DB 依存テストは RUN_PRISMA_CONTRACT=1 のときだけ走る。CREATE/DROP SCHEMA を行うが、
// 対象は下記の専用スキーマ名だけで、他の契約テストが使う public には触れない。

import { describe, beforeAll, afterAll, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma';
// 検査対象: 接続文字列からアダプタを組み立てるファクトリ
import { createPrismaClient } from '@/lib/prisma-client';

// 実 DB を触るテストなので明示フラグでのみ実行する
const SHOULD_RUN = process.env.RUN_PRISMA_CONTRACT === '1';

// 検証に使うスキーマ名。単純な名前だけでなく、引用が要る名前 (ハイフン・空白) も通す。
// 二重引用符を含む名前は Prisma 側が生成 SQL でエスケープしないため対象外
// (受け付けないことは tests/pg-search-path.test.ts で固定している)
const SCHEMA_NAMES = ['contract_app', 'contract-hyphen', 'contract space'];

describe.runIf(SHOULD_RUN)('接続文字列の ?schema= (prisma adapter)', () => {
  // スキーマの作成・後始末に使う、schema 指定なしのクライアント
  let admin: PrismaClient;
  // テスト中に差し替えるので、元の DATABASE_URL を覚えておく
  const originalDatabaseUrl = process.env.DATABASE_URL;

  // スキーマ名を SQL リテラルとして安全に埋め込む (" を "" に増やして引用する)
  const quote = (schema: string) => `"${schema.replace(/"/g, '""')}"`;

  beforeAll(async () => {
    admin = createPrismaClient();
    await admin.$connect();
    // 前回の残骸があっても落ちないよう、作る前に消してから作る
    for (const schema of SCHEMA_NAMES) {
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
      await admin.$executeRawUnsafe(`CREATE SCHEMA ${quote(schema)}`);
    }
  });

  afterAll(async () => {
    // **先に環境変数を戻す**。後片付けが途中で失敗しても、差し替えたままの DSN が
    // 後続の契約テストファイルへ漏れないようにするため (直列実行なので影響が連鎖する)
    process.env.DATABASE_URL = originalDatabaseUrl;
    try {
      // 作った検証用スキーマをすべて片付ける
      for (const schema of SCHEMA_NAMES) {
        await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
      }
    } finally {
      // 片付けが失敗しても接続は必ず閉じる
      await admin.$disconnect();
    }
  });

  // 各スキーマ名について、生 SQL の解決先が指定どおりになることを確かめる
  it.each(SCHEMA_NAMES)('?schema=%s のとき生 SQL も同じスキーマで解決される', async (schema) => {
    // 元の接続文字列に schema パラメータだけを足した DSN を組み立てる
    const url = new URL(originalDatabaseUrl as string);
    url.searchParams.set('schema', schema);
    process.env.DATABASE_URL = url.toString();

    // 差し替えた接続文字列でクライアントを作る
    const scoped = createPrismaClient();
    try {
      // 生 SQL から見える検索対象スキーマが、指定したスキーマ 1 つだけであることを確かめる
      // (current_schemas(false) は search_path の解決結果を配列で返す。Prisma は name[] を
      //  復元できないので text[] へキャストしてから受け取る)
      const [{ schemas }] = await scoped.$queryRawUnsafe<{ schemas: string[] }[]>(
        'SELECT current_schemas(false)::text[] AS schemas',
      );
      expect(schemas).toEqual([schema]);

      // 生 SQL で作ったテーブルが、狙ったスキーマに入っていることも確かめる
      // (search_path が別を向いていれば public 側にできてしまう)
      await scoped.$executeRawUnsafe('CREATE TABLE search_path_probe (id integer)');
      const [{ count }] = await admin.$queryRawUnsafe<{ count: bigint }[]>(
        'SELECT count(*) AS count FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2',
        schema,
        'search_path_probe',
      );
      expect(Number(count)).toBe(1);

      // ここからは **Prisma が組み立てるクエリ側** (アダプタの schema オプション) の確認。
      // 生 SQL だけ見ていると、schema オプションを外す退行を取り逃がす
      // (search_path しか効いていない状態でもこのテストが緑になってしまう)。
      // public の Category と同じ形のテーブルをスコープ側に作り、モデル経由で書き込む
      // (Category を選ぶのは列が scalar だけで、enum 型の解決を巻き込まないため。
      //  LIKE は外部キー制約を写さないので、Tenant 行が無くても挿入できる)
      await scoped.$executeRawUnsafe(
        `CREATE TABLE "Category" (LIKE public."Category" INCLUDING ALL)`,
      );
      // 検証用レコードの ID (スキーマ名ごとに変えて衝突を避ける)
      const categoryId = `schema-probe-${SCHEMA_NAMES.indexOf(schema)}`;
      await scoped.category.create({
        data: { id: categoryId, name: 'スキーマ検証用', tenantId: 'schema-probe-tenant' },
      });
      // 狙ったスキーマ側に 1 件入っていること
      const [{ scopedCount }] = await admin.$queryRawUnsafe<{ scopedCount: bigint }[]>(
        `SELECT count(*) AS "scopedCount" FROM ${quote(schema)}."Category" WHERE id = $1`,
        categoryId,
      );
      expect(Number(scopedCount)).toBe(1);
      // public 側には入っていないこと (schema オプションが効かないとこちらへ落ちる)
      const [{ publicCount }] = await admin.$queryRawUnsafe<{ publicCount: bigint }[]>(
        `SELECT count(*) AS "publicCount" FROM public."Category" WHERE id = $1`,
        categoryId,
      );
      expect(Number(publicCount)).toBe(0);
    } finally {
      // 検証用クライアントの接続を必ず閉じる
      await scoped.$disconnect();
    }
  });

  it('DSN 側の options があっても search_path の固定は生き残る', async () => {
    // 接続先プロバイダが独自の options を載せてくる形 (Neon の endpoint 指定など) を模す。
    // node-postgres は接続文字列側の options を設定オブジェクトへ後勝ちで被せるため、
    // 素朴に渡すと search_path の固定だけが消える (= ORM と生 SQL が別スキーマを向く)
    // DSN 側に **競合する search_path** も混ぜる。連結順を逆にすると DSN 側が後勝ちになり、
    // 生 SQL だけ public へ戻る (ORM は schema オプションのままなので静かに食い違う)
    const url = new URL(originalDatabaseUrl as string);
    url.searchParams.set('schema', SCHEMA_NAMES[0]);
    url.searchParams.set('options', '-c statement_timeout=9000 -c search_path=public');
    process.env.DATABASE_URL = url.toString();

    // 差し替えた接続文字列でクライアントを作る
    const merged = createPrismaClient();
    try {
      // 両方の設定が効いていることを確かめる (DSN 側の指定も、こちらの search_path も)
      const [row] = await merged.$queryRawUnsafe<{ sp: string; timeout: string }[]>(
        "SELECT current_setting('search_path') AS sp, current_setting('statement_timeout') AS timeout",
      );
      expect(row.sp).toBe(`"${SCHEMA_NAMES[0]}"`);
      expect(row.timeout).toBe('9s');
    } finally {
      // 接続を必ず閉じる
      await merged.$disconnect();
    }
  });

  it('?schema= 未指定でも search_path は public に固定される', async () => {
    // 既定の DSN (schema パラメータなし) をそのまま使う
    process.env.DATABASE_URL = originalDatabaseUrl;
    // 既定設定のクライアントを作る
    const defaults = createPrismaClient();
    try {
      // Prisma が組み立てるクエリは public を前提にしているので、生 SQL 側も public に
      // 揃っていないと両者が食い違う (サーバやロールに search_path が設定された環境で顕在化する)
      const [{ schemas }] = await defaults.$queryRawUnsafe<{ schemas: string[] }[]>(
        'SELECT current_schemas(false)::text[] AS schemas',
      );
      expect(schemas).toEqual(['public']);
    } finally {
      // 接続を必ず閉じる
      await defaults.$disconnect();
    }
  });
});
