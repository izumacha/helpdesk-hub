/**
 * Provider-neutral query primitives used by repository ports.
 *
 * Adapters are responsible for translating these into native query shapes
 * (e.g. Prisma `WhereInput`, Drizzle/Kysely builders, raw SQL).
 */

// 文字列部分一致フィルター (LIKE 検索相当)
export interface TextFilter {
  contains: string; // 部分一致させたい文字列
  /** If true, match is case-insensitive (adapter-specific implementation). */
  caseInsensitive?: boolean; // 大文字小文字を無視するか (各アダプタで実装)
}

// ページング指定 (skip 件飛ばして take 件取得)
export interface Page {
  skip: number; // スキップ件数 (オフセット)
  take: number; // 取得件数 (ページサイズ)
}

// 並び替え指定 (指定フィールドを昇順/降順で)
export interface Sort<Field extends string> {
  field: Field; // 並び替え対象のフィールド名
  direction: 'asc' | 'desc'; // 昇順 or 降順
}
