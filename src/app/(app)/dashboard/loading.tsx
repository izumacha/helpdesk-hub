// /dashboard のルートレベル読み込み表示 (Next.js の loading.tsx 規約)。
//
// 監査フォローアップ (2026-09-09): 以前は loading.tsx が無く、集計クエリが終わるまで
// 前のページが表示されたままになっていた (遷移した手応えが無く、遅い回線では
// 「押せていないのでは」と再クリックを誘発する)。ページと同じ骨格のスケルトンを
// 即座に描画し、読み込み中であることを視覚と読み上げの両方で伝える (§7 / §8)。
export default function DashboardLoading() {
  return (
    // ページ本体 (dashboard/page.tsx) と同じ space-y-8 の骨格で場所を確保する
    // (実データへの差し替え時のレイアウトシフトを抑える §8 CLS)
    <div role="status" className="space-y-8">
      {/* 読み上げ専用の状態説明 (スケルトンの形は読み上げでは意味を持たないため) */}
      <span className="sr-only">ダッシュボードを読み込み中</span>
      {/* ページタイトル相当のプレースホルダ */}
      <div>
        {/* h1 相当 (motion-safe: reduced-motion 環境では点滅させない §7) */}
        <div className="h-8 w-48 rounded bg-slate-200/70 motion-safe:animate-pulse" />
        {/* サブテキスト相当 */}
        <div className="mt-2 h-4 w-72 rounded bg-slate-100 motion-safe:animate-pulse" />
      </div>
      {/* ステータスカード群相当のプレースホルダ (Pro の 7 枚グリッドと同じ配置) */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
        {/* カードと同形のプレースホルダを 7 枚並べる */}
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
            {/* 件数部分 */}
            <div className="h-8 w-12 rounded bg-slate-100 motion-safe:animate-pulse" />
            {/* ラベル部分 */}
            <div className="mt-3 h-5 w-20 rounded-full bg-slate-100 motion-safe:animate-pulse" />
          </div>
        ))}
      </div>
      {/* 下段セクション相当のプレースホルダ (SLA タイル / 品質タイルの位置) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* タイルと同形のプレースホルダを 2 枚並べる */}
        {[0, 1].map((i) => (
          <div key={i} className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
            {/* 件数部分 */}
            <div className="h-8 w-12 rounded bg-slate-100 motion-safe:animate-pulse" />
            {/* 説明部分 */}
            <div className="mt-3 h-4 w-40 rounded bg-slate-100 motion-safe:animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}
