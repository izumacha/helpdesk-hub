// 認証ガードの「対象外」判定に使うパス前方一致の純粋関数。
//
// Next.js にも React にも依存しないので、Vitest の node 環境でそのままユニットテスト
// できる（src/lib/nav-active.ts を同じ理由で切り出したのと同じ扱い）。
//
// **src/proxy.ts の中に private で置いてはいけない。** `proxy.ts` が export するのは
// `auth()` で包んだ `proxy` と `config` だけなので、中の述語は外から呼べず、
// tests/proxy-runtime.test.ts もファイル規約（export 名・matcher の形）しか見ていない。
// そこへ置くと「素の startsWith へ戻す」変更が**全テスト緑のまま通る** ——
// この判定はまさにその退行を防ぐために書かれたものなので、守るものが無くなる。

/**
 * パスが接頭辞の「部分木」に入っているか（接頭辞そのものを**含む**）。
 *
 * 素の `startsWith` を使ってはいけない理由: 接頭辞がセグメントの途中で一致する。
 * `'/login'` に `/loginx` が、`'/help'` に `/helpdesk` が、`'/api/auth'` に
 * `/api/authz/...` が一致し、**そのルートを足しただけで認証ガードから静かに外れる**。
 *
 * 接頭辞そのものを含めるのは、公開ページの部分木を丸ごと外したいから。
 * 根が漏れるとヘルプのトップページだけログインを要求される。
 *
 * @param pathname 判定対象のパス（先頭 "/" 付き）
 * @param prefix 部分木の根（末尾に "/" を付けない）
 * @returns 接頭辞そのもの、またはその配下なら true
 */
export function isUnderPath(pathname: string, prefix: string): boolean {
  // 完全一致（部分木の根）か、区切り文字まで含めた前方一致（その下）のどちらかなら配下
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * パスが接頭辞の「配下」に入っているか（接頭辞そのものは**含まない**）。
 *
 * 受信 Webhook の部分木（`/api/inbound` ・ `/api/webhooks`）用。これらは
 * 「根も外す」が成り立たない —— 公開ページと違って根を見せたい理由が無く、
 * 逆に後から `src/app/api/inbound/route.ts`（総称のディスパッチャ等）が足されると、
 * それが**差分に何の合図も出さないまま未認証で公開される**。
 * 実際に配下のルートを持つ子（`/api/inbound/email` 等）は各自が共有シークレットや
 * HMAC で自前に認可するので、外すのは子だけで足りる。
 *
 * @param pathname 判定対象のパス（先頭 "/" 付き）
 * @param prefix 部分木の根（末尾に "/" を付けない）
 * @returns 接頭辞の配下なら true。接頭辞そのものは false
 */
export function isStrictlyUnderPath(pathname: string, prefix: string): boolean {
  // 区切り文字まで含めた前方一致だけを配下とみなす（根そのものは対象外）
  return pathname.startsWith(`${prefix}/`);
}
