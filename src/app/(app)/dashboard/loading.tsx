// /dashboard のルートレベル読み込み表示 (Next.js の loading.tsx 規約)。
//
// 監査フォローアップ (2026-09-09): 以前は loading.tsx が無く、集計クエリが終わるまで
// 前のページが表示されたままになっていた (遷移した手応えが無く、遅い回線では
// 「押せていないのでは」と再クリックを誘発する)。スケルトンを即座に描画し、
// 読み込み中であることを視覚と読み上げの両方で伝える (§7 / §8)。
//
// 形はモード中立にする (/code-review ultra 指摘対応): この階層ではテナントの
// mode (lite | pro) をまだ知り得ないため、Pro の 7 枚グリッドを模すと既定モードの
// Lite (2 枚タイル) では確実にレイアウトが飛ぶ。既定モードの Lite と同じ
// 「見出し + 2 枚タイル」の最小骨格に留め、Pro でも上部 (見出し位置) は一致させる
export default function DashboardLoading() {
  return (
    // ページ本体 (dashboard/page.tsx) と同じ space-y-8 の骨格で場所を確保する
    <div role="status" className="space-y-8">
      {/* 読み上げ専用の状態説明 (スケルトンの形は読み上げでは意味を持たないため) */}
      <span className="sr-only">ダッシュボードを読み込み中</span>
      {/* ページタイトル相当のプレースホルダ */}
      <div>
        {/* h1 相当 */}
        {/* スケルトンの点滅 (animate-pulse)。**motion-reduce の手当てはここに書かない** —
            globals.css の prefers-reduced-motion 指定が * に対して animation-duration を
            上書きするので既に止まっており、重ねても挙動は変わらず「どちらが効いているのか」が
            読めなくなるだけ (Sidebar.tsx の transition と同じ判断。§6 / §7) */}
        <div className="h-8 w-48 animate-pulse rounded bg-slate-200/70" />
        {/* サブテキスト相当 */}
        <div className="mt-2 h-4 w-72 animate-pulse rounded bg-slate-100" />
      </div>
      {/* タイル群相当のプレースホルダ (Lite の 2 枚タイルと同じ配置。Pro でも
          「この位置に集計タイルが来る」ことだけを予告する控えめな形に留める) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* タイルと同形のプレースホルダを 2 枚並べる */}
        {[0, 1].map((i) => (
          <div key={i} className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
            {/* ラベル部分 */}
            <div className="h-4 w-28 animate-pulse rounded bg-slate-100" />
            {/* 件数部分 */}
            <div className="mt-3 h-10 w-16 animate-pulse rounded bg-slate-100" />
            {/* 説明部分 */}
            <div className="mt-2 h-3 w-40 animate-pulse rounded bg-slate-100" />
          </div>
        ))}
      </div>
    </div>
  );
}
