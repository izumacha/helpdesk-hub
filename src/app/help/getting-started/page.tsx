// 30 分で運用開始するスタートガイドページ
// Phase 3「ヘルプセンター」+ Phase 7.1「30 分で運用開始シナリオ」に対応
import Link from 'next/link';
// チュートリアル動画リンクの解決ヘルパー (未設定/不正 URL のときは null)
import { getTutorialVideoUrl } from '@/lib/tutorial-video';

// 認証不要・静的コンテンツのため SSG で出力する (CDN キャッシュに乗り高速化)。
// TUTORIAL_VIDEO_URL はこの force-static ページではビルド時点の値が焼き込まれる
// (値を変える場合は再ビルドが必要。他の env 依存ページと同じ運用上の制約)
export const dynamic = 'force-static';

export const metadata = {
  title: '30 分で運用開始する | ヘルプセンター | HelpDesk Hub',
};

// スタートガイドページ
export default function GettingStartedPage() {
  // チュートリアル動画リンク (未設定/不正 URL のときは null。その場合は案内自体を出さない)
  const tutorialVideoUrl = getTutorialVideoUrl();

  return (
    <div className="space-y-8">
      {/* ページタイトル */}
      <div>
        <p className="text-sm font-medium text-teal-700">スタートガイド</p>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">30 分で運用開始する</h1>
        <p className="mt-2 text-slate-600">
          メールアドレスさえあれば、今日中に問い合わせ管理を始められます。
          このガイドに沿って進めると 30 分ほどで完了します。
        </p>
        {/* チュートリアル動画へのリンク (TUTORIAL_VIDEO_URL 未設定の間は表示しない) */}
        {tutorialVideoUrl && (
          <p className="mt-3 text-sm">
            {/* 外部動画のため新しいタブで開き、rel でタブナビゲーション経由の攻撃を防ぐ (§7 a11y) */}
            <a
              href={tutorialVideoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-medium text-teal-700 underline hover:text-teal-900"
            >
              動画で全体の流れを見る
            </a>
          </p>
        )}
      </div>

      {/* ステップ 1: ログイン */}
      <section aria-labelledby="step1-heading">
        <div className="flex items-center gap-3">
          {/* ステップ番号バッジ */}
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-teal-100 text-sm font-bold text-teal-800"
            aria-hidden="true"
          >
            1
          </span>
          <h2 id="step1-heading" className="text-lg font-semibold text-slate-900">
            メールアドレスでログインする
          </h2>
        </div>
        <div className="ml-11 mt-3 space-y-2 text-sm text-slate-600">
          <p>
            HelpDesk Hub はパスワード不要のログイン（マジックリンク認証）に対応しています。
            ログイン画面でメールアドレスを入力すると、ログイン用のリンクが届きます。
          </p>
          <ol className="ml-4 list-decimal space-y-1">
            {/* ログイン手順 */}
            <li>ログイン画面を開く</li>
            <li>メールアドレスを入力して「ログインリンクを送る」をクリックする</li>
            <li>届いたメールのリンクをクリックする</li>
            <li>ログイン完了</li>
          </ol>
          <p className="text-xs text-slate-500">
            ※ リンクは 15 分間有効です。届かない場合は迷惑メールフォルダを確認してください。
          </p>
        </div>
      </section>

      {/* ステップ 2: メンバーを招待 */}
      <section aria-labelledby="step2-heading">
        <div className="flex items-center gap-3">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-teal-100 text-sm font-bold text-teal-800"
            aria-hidden="true"
          >
            2
          </span>
          <h2 id="step2-heading" className="text-lg font-semibold text-slate-900">
            メンバーを招待する
          </h2>
        </div>
        <div className="ml-11 mt-3 space-y-2 text-sm text-slate-600">
          <p>
            問い合わせを出す人（メンバー）と、対応する人（担当者）をシステムに招待します。
          </p>
          <ol className="ml-4 list-decimal space-y-1">
            {/* 招待手順 */}
            <li>「設定」メニューを開く</li>
            <li>「メンバーを招待」セクションで役割を選ぶ（メンバー / 担当者）</li>
            <li>表示された招待リンクをコピーして、メール・LINE・Slack 等で共有する</li>
            <li>相手がリンクをクリックして名前・メールを入力すると参加完了</li>
          </ol>
        </div>
      </section>

      {/* ステップ 3: メール転送の設定 */}
      <section aria-labelledby="step3-heading">
        <div className="flex items-center gap-3">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-teal-100 text-sm font-bold text-teal-800"
            aria-hidden="true"
          >
            3
          </span>
          <h2 id="step3-heading" className="text-lg font-semibold text-slate-900">
            メール転送を設定する（任意・推奨）
          </h2>
        </div>
        <div className="ml-11 mt-3 space-y-2 text-sm text-slate-600">
          <p>
            既存のメールアドレスに届いた問い合わせを自動でチケット化できます。
            「アプリを開かなくてもメールで送ればいい」という方に最適です。
          </p>
          <p>
            詳しくは{' '}
            <Link href="/help/email-integration" className="text-teal-700 underline hover:text-teal-900">
              メールから問い合わせを取り込む
            </Link>{' '}
            をご覧ください。
          </p>
        </div>
      </section>

      {/* ステップ 4: 最初の問い合わせを作成 */}
      <section aria-labelledby="step4-heading">
        <div className="flex items-center gap-3">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-teal-100 text-sm font-bold text-teal-800"
            aria-hidden="true"
          >
            4
          </span>
          <h2 id="step4-heading" className="text-lg font-semibold text-slate-900">
            最初の問い合わせを作成する
          </h2>
        </div>
        <div className="ml-11 mt-3 space-y-2 text-sm text-slate-600">
          <p>
            サンプルチケットが 2 件登録されているはずです。試しに「新規登録」から問い合わせを
            1 件作ってみましょう。
          </p>
          <ul className="ml-4 list-disc space-y-1">
            {/* 入力のコツ */}
            <li>件名: 「PC が起動しない」のような短い説明</li>
            <li>内容: 状況の詳細（いつから、どのような状態か）</li>
            <li>写真: スマホで撮影した画像を添付できます</li>
          </ul>
          <p>
            詳しくは{' '}
            <Link href="/help/tickets" className="text-teal-700 underline hover:text-teal-900">
              問い合わせの管理
            </Link>{' '}
            をご覧ください。
          </p>
        </div>
      </section>

      {/* 完了メッセージ */}
      <div className="rounded-xl bg-teal-50 p-5">
        <h2 className="text-sm font-semibold text-teal-900">これで運用開始できます 🎉</h2>
        <p className="mt-1 text-sm text-teal-700">
          お疲れ様でした。ここまで完了すれば、Excel なしでチームの問い合わせを管理できます。
          わからないことがあればこのヘルプセンターをご活用ください。
        </p>
      </div>
    </div>
  );
}
