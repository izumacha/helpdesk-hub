// メール取り込みのヘルプページ
// Phase 2 メール取り込み機能の利用方法を説明する
// Phase 3「ヘルプセンター」に対応

export const metadata = {
  title: 'メールから問い合わせを取り込む | ヘルプセンター | HelpDesk Hub',
};

// メール取り込みヘルプページ
export default function EmailIntegrationHelpPage() {
  return (
    <div className="space-y-8">
      {/* ページタイトル */}
      <div>
        <p className="text-sm font-medium text-teal-700">メール取り込み</p>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">メールから問い合わせを取り込む</h1>
        <p className="mt-2 text-slate-600">
          既存のメールアドレスに届いた問い合わせを自動でチケット化します。
          アプリを開かなくても、今まで通りメールで送るだけでOKです。
        </p>
      </div>

      {/* 仕組みの説明 */}
      <section aria-labelledby="how-heading">
        <h2 id="how-heading" className="text-lg font-semibold text-slate-900">
          仕組み
        </h2>
        <div className="mt-3 space-y-3 text-sm text-slate-600">
          {/* 流れを視覚的に表現する */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
            <div className="flex-1 rounded-lg bg-slate-50 p-3 text-center">
              <span className="text-lg" aria-hidden="true">📧</span>
              <p className="mt-1 font-medium text-slate-700">依頼者がメールを送る</p>
              <p className="text-xs text-slate-500">今まで通りのメールアドレスへ転送</p>
            </div>
            {/* 矢印 */}
            <span className="hidden text-slate-400 sm:block" aria-hidden="true">→</span>
            <div className="flex-1 rounded-lg bg-slate-50 p-3 text-center">
              <span className="text-lg" aria-hidden="true">⚙️</span>
              <p className="mt-1 font-medium text-slate-700">自動でチケット化</p>
              <p className="text-xs text-slate-500">HelpDesk Hub が受信してチケットを作成</p>
            </div>
            <span className="hidden text-slate-400 sm:block" aria-hidden="true">→</span>
            <div className="flex-1 rounded-lg bg-slate-50 p-3 text-center">
              <span className="text-lg" aria-hidden="true">✅</span>
              <p className="mt-1 font-medium text-slate-700">担当者が対応</p>
              <p className="text-xs text-slate-500">問い合わせ一覧に表示される</p>
            </div>
          </div>
        </div>
      </section>

      {/* 設定手順 */}
      <section aria-labelledby="setup-heading">
        <h2 id="setup-heading" className="text-lg font-semibold text-slate-900">
          設定手順
        </h2>
        <div className="mt-3 space-y-4 text-sm text-slate-600">
          {/* ステップ 1 */}
          <div>
            <p className="font-medium text-slate-800">① 専用の転送先アドレスを確認する</p>
            <p className="mt-1">
              ダッシュボードの「はじめかた」セクション、またはシステム管理者から
              転送先のメールアドレスを受け取ります。
            </p>
            <div className="mt-2 rounded-lg bg-slate-50 px-4 py-3 font-mono text-xs text-slate-700">
              例: xxxxxxxx@inbox.helpdesk-hub.app
            </div>
          </div>

          {/* ステップ 2 */}
          <div>
            <p className="font-medium text-slate-800">② 既存のメールを自動転送する</p>
            <p className="mt-1">
              問い合わせを受け取っているメールアドレス（Gmail など）で
              「自動転送」の設定を行います。
              届いたメールを上記のアドレスへ自動転送するように設定してください。
            </p>
            <div className="mt-2 space-y-1 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
              <p className="font-medium">Gmail の場合（参考手順）</p>
              <ol className="ml-4 list-decimal space-y-0.5">
                {/* Gmail 設定手順 */}
                <li>Gmail の設定 → 「メールの転送と POP/IMAP」を開く</li>
                <li>「転送先アドレスを追加する」をクリック</li>
                <li>転送先メールアドレスを入力して確認コードを受け取る</li>
                <li>「転送を有効にする」を選択して保存する</li>
              </ol>
            </div>
          </div>

          {/* ステップ 3 */}
          <div>
            <p className="font-medium text-slate-800">③ テスト送信して確認する</p>
            <p className="mt-1">
              転送設定後、テストメールを送って問い合わせ一覧にチケットが作成されるか確認します。
              通常 1 分以内にチケット化されます。
            </p>
          </div>
        </div>
      </section>

      {/* 注意事項 */}
      <section aria-labelledby="notes-heading">
        <h2 id="notes-heading" className="text-lg font-semibold text-slate-900">
          注意事項
        </h2>
        <div className="mt-3 space-y-2 text-sm text-slate-600">
          <ul className="ml-4 list-disc space-y-1">
            {/* 注意点 */}
            <li>
              組織内に登録済みのメールアドレスからのメールは自動でチケット化されます。
              未登録のアドレスからのメールはシステムが受け取りますが、
              担当者が確認の上で処理する場合があります。
            </li>
            <li>
              返信メールもスレッドとして既存チケットに追記されます（同じ件名・スレッドの場合）。
            </li>
            <li>
              大量のスパムメールが届く場合は管理者にご連絡ください。
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
}
