// ヘルプセンターのトップページ (記事一覧)
// Phase 3「ヘルプセンター（このリポジトリ内に Next.js で同梱、SSG）」に対応
import Link from 'next/link';

// このページは認証不要・更新頻度が低い静的コンテンツのため SSG (Static Site Generation) で出力する
// 動的レンダリングが行われないようにすることで CDN キャッシュに乗り、ロードを高速化する
export const dynamic = 'force-static';

// ヘルプセンターのページメタデータ
export const metadata = {
  title: 'ヘルプセンター | HelpDesk Hub',
};

// ヘルプセンタートップページ (カテゴリ別の記事一覧を表示する)
export default function HelpIndexPage() {
  return (
    <div className="space-y-8">
      {/* ページタイトル */}
      <div>
        <h1 className="text-3xl font-bold text-slate-900">ヘルプセンター</h1>
        <p className="mt-2 text-slate-600">
          HelpDesk Hub の使い方についての説明とよくある質問をまとめています。
        </p>
      </div>

      {/* 記事カテゴリ一覧 */}
      <div className="grid gap-4 sm:grid-cols-2">
        {/* はじめ方 カード */}
        <Link
          href="/help/getting-started"
          className="group block rounded-xl border border-slate-200 p-5 transition hover:border-teal-300 hover:bg-teal-50/40"
        >
          <div className="flex items-start gap-3">
            {/* アイコン（絵文字で視覚的に区別） */}
            <span className="text-2xl" aria-hidden="true">🚀</span>
            <div>
              <h2 className="text-base font-semibold text-slate-900 group-hover:text-teal-800">
                30 分で運用開始する
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                初めての方向けのスタートガイドです。メンバー招待からメール取り込みまで順を追って説明します。
              </p>
            </div>
          </div>
        </Link>

        {/* 問い合わせ管理 カード */}
        <Link
          href="/help/tickets"
          className="group block rounded-xl border border-slate-200 p-5 transition hover:border-teal-300 hover:bg-teal-50/40"
        >
          <div className="flex items-start gap-3">
            <span className="text-2xl" aria-hidden="true">🎫</span>
            <div>
              <h2 className="text-base font-semibold text-slate-900 group-hover:text-teal-800">
                問い合わせの管理
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                問い合わせの作成・担当者の割り当て・状況の変更方法を説明します。
              </p>
            </div>
          </div>
        </Link>

        {/* メール取り込み カード */}
        <Link
          href="/help/email-integration"
          className="group block rounded-xl border border-slate-200 p-5 transition hover:border-teal-300 hover:bg-teal-50/40"
        >
          <div className="flex items-start gap-3">
            <span className="text-2xl" aria-hidden="true">📧</span>
            <div>
              <h2 className="text-base font-semibold text-slate-900 group-hover:text-teal-800">
                メールから問い合わせを取り込む
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                既存のメールアドレスに届いた問い合わせを自動でチケット化する方法を説明します。
              </p>
            </div>
          </div>
        </Link>

        {/* ログインのコツ カード (インライン記事) */}
        <div className="rounded-xl border border-slate-200 p-5">
          <div className="flex items-start gap-3">
            <span className="text-2xl" aria-hidden="true">🔑</span>
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                パスワード不要でログインする
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                メールアドレスを入力してリンクを受け取るだけでログインできます（マジックリンク認証）。
                パスワードを覚える必要はありません。
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* 困ったときの導線 */}
      <div className="rounded-xl bg-teal-50 p-5">
        <h2 className="text-sm font-semibold text-teal-900">解決しない場合は</h2>
        <p className="mt-1 text-sm text-teal-700">
          このヘルプで解決しない場合は、システム管理者またはヘルプデスク担当者にお問い合わせください。
        </p>
      </div>
    </div>
  );
}
