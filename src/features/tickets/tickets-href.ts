// チケット一覧 (/tickets) の URL を組み立てる純粋関数。
//
// /code-review ultra 指摘対応 (2026-09-10): 「今のクエリを複製し、いくつか差し替え／取り除き、
// page を先頭へ戻し、空なら "?" を付けない」という同じ規則が 3 箇所に書かれていた
// (一覧ページのページャ／期限チップ・TicketTabs・TicketFilters)。§6 は「2〜3 箇所目で
// 共通化する」としており、ここが 3 箇所目にあたる。
//
// **「どのキーを消すか」という方針は呼び出し側に残す**。タブ切替は due を消し、
// 絞り込みフォームは残す、というように方針は意図的に違うため、ここへ寄せると
// かえって読めなくなる。共通化するのは組み立ての手順だけ。

// 一覧ページのパス (呼び出し側で書き写さないよう定数にする)
const TICKETS_PATH = '/tickets';

// ページ番号のクエリキー。絞り込みやタブを変えたら必ず先頭ページへ戻すため、
// この関数が常に取り除く (「2 ページ目のまま条件だけ変わって 0 件」を防ぐ)
const PAGE_KEY = 'page';

/**
 * チケット一覧の URL を組み立てる。
 *
 * @param source 現在のクエリ (URLSearchParams、またはサーバ側の searchParams オブジェクト)
 * @param changes set: 差し替える値 / remove: 取り除くキー
 * @returns `/tickets` または `/tickets?...` の形の URL
 */
export function buildTicketsHref(
  source: URLSearchParams | Record<string, string | undefined>,
  changes: { set?: Record<string, string>; remove?: string[] } = {},
): string {
  // 入力を URLSearchParams にそろえる (元のオブジェクトは書き換えない)
  const params =
    source instanceof URLSearchParams
      ? new URLSearchParams(source.toString())
      : new URLSearchParams(
          // 値が undefined のキーは URL に載せない (型を string に絞り込む)
          Object.entries(source).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        );
  // 取り除く指定のあったキーを落とす
  for (const key of changes.remove ?? []) params.delete(key);
  // 差し替える値を上書きする
  for (const [key, value] of Object.entries(changes.set ?? {})) params.set(key, value);
  // ページ番号は常に落とす。ただし呼び出し側が set で明示した場合はそちらを尊重する
  // (ページャ自身は set: { page: '2' } の形で呼ぶため)
  if (changes.set?.[PAGE_KEY] === undefined) params.delete(PAGE_KEY);
  // クエリが空なら "?" を付けない素の一覧 URL にする
  const qs = params.toString();
  return qs ? `${TICKETS_PATH}?${qs}` : TICKETS_PATH;
}
