// リポジトリポートで使う、プロバイダ非依存のクエリ用プリミティブ型。
// アダプタが Prisma WhereInput や SQL など、各 ORM / DB 固有の形に変換する責務を持つ。

// 文字列部分一致フィルター (LIKE 検索相当)
export interface TextFilter {
  contains: string; // 部分一致させたい文字列
  caseInsensitive?: boolean; // true のとき大文字小文字を無視する (各アダプタで実装)
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
