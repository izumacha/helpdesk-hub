// セッション (ログイン情報) 取得
import { auth } from '@/lib/auth';
// データ層の Composition Root (Prisma 直叩きを避ける)
import { repos } from '@/data';
// エージェント/管理者判定
import { isAgent } from '@/lib/role';
// FAQ ステータスの日本語ラベル + Tailwind カラークラス + FAQ 機能自体の mode-aware 呼称
import { FAQ_STATUS_LABELS, FAQ_STATUS_COLORS, FAQ_TERM_LABELS } from '@/lib/constants';
// FAQ の状態を更新するサーバーアクション
import { updateFaqStatus } from '@/features/faq/actions/faq-actions';
// FAQ の質問/回答本文をその場編集するクライアントコンポーネント
import { FaqEditForm } from '@/features/faq/components/FaqEditForm';
// テナントの動作モード (lite | pro) を取得するヘルパー
import { getCurrentTenantMode } from '@/lib/tenant';

// FAQ の質問文/回答文を表示する共通ブロック (依頼者向け・エージェント向け両ビューで再利用)
function FaqQaBlock({ question, answer }: { question: string; answer: string }) {
  return (
    <>
      {/* 質問文 (ページの h1 のすぐ下に来るため h2 とし、見出し階層を飛ばさない) */}
      <h2 className="mb-2 text-base font-semibold text-slate-900">Q. {question}</h2>
      {/* 回答文 (改行を保持したまま表示する) */}
      <p className="text-sm leading-relaxed whitespace-pre-wrap text-slate-600">A. {answer}</p>
    </>
  );
}

// 0 件時の空状態カード (依頼者向け・エージェント向け両ビューで再利用)
function FaqEmptyState({ termLabel }: { termLabel: string }) {
  return (
    <div className="rounded-2xl bg-white py-20 text-center text-slate-400 ring-1 ring-slate-200">
      {/* まだ 1 件も無いことを伝える文言 */}
      <p className="text-sm">{termLabel}はまだありません</p>
    </div>
  );
}

// /faq : FAQ 一覧ページ。
// フォローアップ (2026-07-14 #5): 監査で発見したギャップの解消。以前はエージェント以上のみが
// 閲覧可能で、依頼者は 404 で弾かれていた。§2 のギャップ分析表が謳う「またこの質問か」を
// 減らす狙い (§0 北極星指標にも通じる) を満たすには、公開済み FAQ を依頼者自身が読めなければ
// 意味がない。エージェントは従来どおりの候補管理ビュー、依頼者は公開済み FAQ の閲覧専用ビューを
// 見る (ロールで表示を分岐し、どちらも 404 にはしない)。
export default async function FaqPage() {
  // セッション取得
  const session = await auth();
  // 未ログイン or tenantId 不在なら何も描画しない
  if (!session?.user?.id || !session.user.tenantId) return null;
  // セッションから tenantId を取り出す
  const tenantId = session.user.tenantId;
  // ロール判定 (エージェント以上かどうかで表示を分岐する)
  const agent = isAgent(session.user.role);
  // テナントの動作モードを取得し、見出し文言 (Lite:「よくある質問」/ Pro:「FAQ候補」) に使う
  const mode = await getCurrentTenantMode(tenantId);
  // この機能の呼称
  const termLabel = FAQ_TERM_LABELS[mode];

  // 依頼者 (非エージェント) 向け: 公開済み FAQ のみを閲覧専用で表示する
  // (元チケット・作成者・ステータスバッジ・公開/却下操作は含めない)
  if (!agent) {
    // 公開済み FAQ 一覧を取得 (質問/回答のみ。§9 最小権限・最小公開)
    const publishedFaqs = await repos.faq.listPublished(tenantId);
    return (
      <div className="space-y-6">
        {/* ページヘッダー: タイトル + サブテキスト */}
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{termLabel}</h1>
          <p className="mt-1 text-sm text-slate-500">
            過去の問い合わせから作成された{termLabel}です。同じ内容がないか探してみましょう。
          </p>
        </div>

        {/* 0 件なら空状態カード、1 件以上あれば一覧を出し分ける */}
        {publishedFaqs.length === 0 ? (
          // 0 件時の空状態 (柔らかなカード。管理画面側と同じスタイル)
          <FaqEmptyState termLabel={termLabel} />
        ) : (
          // 1 件以上ある場合は順に列挙 (質問と回答のみのシンプルな読み取り専用カード)
          <div className="space-y-4">
            {/* 公開済み FAQ を 1 件ずつカードにして描画する */}
            {publishedFaqs.map((faq) => (
              <div
                key={faq.id}
                className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100"
              >
                <FaqQaBlock question={faq.question} answer={faq.answer} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // エージェント以上向け: 従来どおりの候補管理ビュー (公開/却下操作を含む)
  // 当該テナントの FAQ 一覧を取得 (元チケットと作成者名を含む、全ステータス)
  const faqs = await repos.faq.list(tenantId);

  return (
    <div className="space-y-6">
      {/* ページヘッダー: タイトル + サブテキスト */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{termLabel}一覧</h1>
        <p className="mt-1 text-sm text-slate-500">
          完了した問い合わせから抽出されたナレッジ候補を公開・却下できます。
        </p>
      </div>

      {/* 0 件なら空状態カード、1 件以上あれば一覧を出し分ける */}
      {faqs.length === 0 ? (
        // 0 件時の空状態 (柔らかなカード)
        <FaqEmptyState termLabel={termLabel} />
      ) : (
        // 1 件以上ある場合は順に列挙
        <div className="space-y-4">
          {/* FAQ 候補を 1 件ずつカードにして描画する (ステータスバッジ・操作ボタン付き) */}
          {faqs.map((faq) => (
            <div
              key={faq.id}
              className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100 transition hover:ring-teal-200"
            >
              {/* 上段: ステータスバッジ + 元チケットへのリンク */}
              <div className="mb-3 flex items-center justify-between gap-3">
                <span
                  className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${FAQ_STATUS_COLORS[faq.status] ?? ''}`}
                >
                  {FAQ_STATUS_LABELS[faq.status] ?? faq.status}
                </span>
                <span className="text-xs text-slate-400">
                  登録者: {faq.createdBy.name} / 元チケット:{' '}
                  <a
                    href={`/tickets/${faq.ticket.id}`}
                    className="text-teal-700 transition hover:text-teal-800 hover:underline"
                  >
                    {faq.ticket.title}
                  </a>
                </span>
              </div>

              {/* 質問と回答本文 (依頼者向けビューと共通のブロックを再利用) */}
              <FaqQaBlock question={faq.question} answer={faq.answer} />

              {/* 質問/回答をその場編集するフォーム (ステータス不問。フォローアップ 2026-07-14 #6:
                  公開後に誤りへ気付いても訂正する手段が無かったギャップ対応) */}
              <FaqEditForm faqId={faq.id} question={faq.question} answer={faq.answer} />

              {/* Candidate 状態のときのみ「公開/却下」ボタンを表示 */}
              {faq.status === 'Candidate' && (
                <div className="mt-4 flex gap-2">
                  {/* 公開ボタン (アクションに引数をバインド) ─ ミントグリーンの主要 CTA */}
                  <form action={updateFaqStatus.bind(null, faq.id, 'Published')}>
                    <button
                      type="submit"
                      className="rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-700"
                    >
                      公開する
                    </button>
                  </form>
                  {/* 却下ボタン ─ outlined で控えめに */}
                  <form action={updateFaqStatus.bind(null, faq.id, 'Rejected')}>
                    <button
                      type="submit"
                      className="rounded-lg border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
                    >
                      却下
                    </button>
                  </form>
                </div>
              )}

              {/* Published 状態のときのみ「非公開にする」ボタンを表示 (誤って公開した内容を
                  依頼者向け閲覧から取り下げる導線。フォローアップ 2026-07-14 #6) */}
              {faq.status === 'Published' && (
                <div className="mt-4">
                  <form action={updateFaqStatus.bind(null, faq.id, 'Rejected')}>
                    <button
                      type="submit"
                      className="rounded-lg border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
                    >
                      非公開にする
                    </button>
                  </form>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
