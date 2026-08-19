// PostgreSQL の接続時オプション (libpq の `options` パラメータ) を組み立てる純粋関数。
// Prisma に依存しないので、ユニットテストからそのまま呼べる (DB も不要)。

/**
 * Builds the libpq `options` value that pins a connection's `search_path`.
 *
 * Why this is needed at all: the Prisma driver adapter's `schema` option only
 * qualifies the queries Prisma generates. Raw SQL (`$queryRaw` /
 * `$executeRawUnsafe`) still resolves through `search_path`, so without this
 * the two halves would silently target different schemas.
 *
 * Why it is built by hand: `search_path` cannot be set with a bind parameter
 * (`SET` takes no placeholders), and node-postgres has no hook that runs — and
 * is awaited — before a freshly opened pooled connection is handed out, so a
 * `SELECT set_config(...)` after connect would race the first query. The
 * startup option is applied by the server before any query runs.
 *
 * Two layers of quoting are therefore required, in this order:
 *   1. GUC value: wrap the name in double quotes so hyphens, spaces, upper case
 *      and reserved words survive, doubling any embedded double quote
 *      (`we"ird` → `"we""ird"`). This also stops a name from being read as a
 *      comma-separated list, i.e. from appending extra schemas.
 *   2. libpq `options`: escape backslashes and spaces, which libpq itself
 *      consumes as separators/escapes before the server ever sees the value.
 */
// 接続時に search_path を固定する libpq options 文字列を組み立てる
export function buildSearchPathOption(schema: string): string {
  // 空文字は search_path として意味を成さない (どのスキーマも指さない) ので弾く
  if (schema.length === 0) {
    throw new Error('DATABASE_URL の ?schema= が空です。スキーマ名を指定してください。');
  }
  // (1) GUC 値としての引用: 埋め込まれた " を "" に増やしてから全体を " で囲む
  const quotedIdentifier = `"${schema.replace(/"/g, '""')}"`;
  // (2) libpq の options としての引用: libpq が食べてしまう \ と空白を \ で退避する
  const escapedForLibpq = quotedIdentifier.replace(/[\\ ]/g, (character) => `\\${character}`);
  // 接続確立時に適用される設定として返す
  return `-c search_path=${escapedForLibpq}`;
}
