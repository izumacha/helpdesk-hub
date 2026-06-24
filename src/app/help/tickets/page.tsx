// 問い合わせ管理のヘルプページ
// Phase 3「ヘルプセンター」に対応

// 認証不要・静的コンテンツのため SSG で出力する (CDN キャッシュに乗り高速化)
export const dynamic = 'force-static';

export const metadata = {
  title: '問い合わせの管理 | ヘルプセンター | HelpDesk Hub',
};

// 問い合わせ管理ヘルプページ
export default function TicketsHelpPage() {
  return (
    <div className="space-y-8">
      {/* ページタイトル */}
      <div>
        <p className="text-sm font-medium text-teal-700">問い合わせ管理</p>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">問い合わせの管理</h1>
        <p className="mt-2 text-slate-600">
          問い合わせ（チケット）の作成から完了まで、基本的な操作を説明します。
        </p>
      </div>

      {/* 問い合わせの作成 */}
      <section aria-labelledby="create-heading">
        <h2 id="create-heading" className="text-lg font-semibold text-slate-900">
          問い合わせを作成する
        </h2>
        <div className="mt-3 space-y-2 text-sm text-slate-600">
          <p>
            サイドバーの「新規登録」またはダッシュボードのボタンから問い合わせを作成できます。
          </p>
          <div className="rounded-lg bg-slate-50 p-4">
            <p className="font-medium text-slate-700">入力項目</p>
            <ul className="mt-2 ml-4 list-disc space-y-1">
              {/* 入力項目の説明 */}
              <li>
                <span className="font-medium">件名（必須）</span> — 何が困っているかを短く書く
              </li>
              <li>
                <span className="font-medium">内容（必須）</span> — 状況の詳細。いつから・どんな状態か
              </li>
              <li>
                <span className="font-medium">期限</span> — いつまでに解決してほしいかの目安
              </li>
              <li>
                <span className="font-medium">写真</span> — エラー画面や故障箇所の写真を添付できます
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* 状況（ステータス）の管理 */}
      <section aria-labelledby="status-heading">
        <h2 id="status-heading" className="text-lg font-semibold text-slate-900">
          状況を変更する
        </h2>
        <div className="mt-3 space-y-2 text-sm text-slate-600">
          <p>
            問い合わせには 3 つの状況があります。担当者が対応の進み具合に合わせて変更します。
          </p>
          <div className="space-y-2">
            {/* ステータス説明 */}
            <div className="flex items-start gap-3 rounded-lg bg-slate-50 p-3">
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                未対応
              </span>
              <p>新しく届いた問い合わせ。まだ誰も対応していない状態。</p>
            </div>
            <div className="flex items-start gap-3 rounded-lg bg-slate-50 p-3">
              <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
                対応中
              </span>
              <p>担当者が作業中の状態。依頼者に「確認しています」と伝えるときに変更する。</p>
            </div>
            <div className="flex items-start gap-3 rounded-lg bg-slate-50 p-3">
              <span className="rounded-full bg-teal-100 px-2 py-0.5 text-xs font-medium text-teal-800">
                完了
              </span>
              <p>対応が終わった状態。依頼者へ完了のメールが自動で届きます。</p>
            </div>
          </div>
          <p className="text-xs text-slate-500">
            ※ 詳細モード（Pro）では「オープン」「ユーザー待ち」「エスカレーション」「解決済み」なども使えます。
          </p>
        </div>
      </section>

      {/* コメントと返信 */}
      <section aria-labelledby="comment-heading">
        <h2 id="comment-heading" className="text-lg font-semibold text-slate-900">
          コメントで返信する
        </h2>
        <div className="mt-3 space-y-2 text-sm text-slate-600">
          <p>
            問い合わせの詳細画面からコメントを投稿できます。
            担当者がコメントすると、依頼者にメールで通知が届きます。
            依頼者はアプリにログインしなくても、メールで内容を確認できます。
          </p>
          <p>
            コメントには写真を添付することもできます（現場の追加写真など）。
          </p>
        </div>
      </section>

      {/* 期限切れの確認 */}
      <section aria-labelledby="deadline-heading">
        <h2 id="deadline-heading" className="text-lg font-semibold text-slate-900">
          期限切れを確認する
        </h2>
        <div className="mt-3 space-y-2 text-sm text-slate-600">
          <p>
            ダッシュボードの「期限切れ・今日まで」タブで、対応期限を過ぎた問い合わせを
            まとめて確認できます。優先的に対応しましょう。
          </p>
        </div>
      </section>
    </div>
  );
}
