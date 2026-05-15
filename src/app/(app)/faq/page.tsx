// セッション (ログイン情報) 取得
import { auth } from '@/lib/auth';
// データ層の Composition Root (Prisma 直叩きを避ける)
import { repos } from '@/data';
// 404 へ飛ばすヘルパー (権限不足時に使用)
import { notFound } from 'next/navigation';
// エージェント/管理者判定
import { isAgent } from '@/lib/role';
// FAQ ステータスの日本語ラベル + Tailwind カラークラス
import { FAQ_STATUS_LABELS, FAQ_STATUS_COLORS } from '@/lib/constants';
// FAQ の状態を更新するサーバーアクション
import { updateFaqStatus } from '@/features/faq/actions/faq-actions';

// /faq : FAQ 候補一覧ページ (エージェント以上のみ閲覧可)
export default async function FaqPage() {
  // セッション取得
  const session = await auth();
  // 未ログイン or tenantId 不在なら何も描画しない
  if (!session?.user?.id || !session.user.tenantId) return null;
  // 一般ユーザー (依頼者) は 404 で隠す
  if (!isAgent(session.user.role)) notFound();

  // 当該テナントの FAQ 候補を新しい順で全件取得 (元チケットと作成者名を含む、port 経由)
  const faqs = await repos.faq.list(session.user.tenantId);

  return (
    <div className="space-y-6">
      {/* ページヘッダー: タイトル + サブテキスト */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">FAQ候補一覧</h1>
        <p className="mt-1 text-sm text-slate-500">
          解決済みチケットから抽出されたナレッジ候補を公開・却下できます。
        </p>
      </div>

      {faqs.length === 0 ? (
        // 0 件時の空状態 (柔らかなカード)
        <div className="rounded-2xl bg-white py-20 text-center text-slate-400 ring-1 ring-slate-200">
          <p className="text-sm">FAQ候補はまだありません</p>
        </div>
      ) : (
        // 1 件以上ある場合は順に列挙
        <div className="space-y-4">
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

              {/* 質問と回答本文 */}
              <h3 className="mb-2 text-base font-semibold text-slate-900">Q. {faq.question}</h3>
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-slate-600">
                A. {faq.answer}
              </p>

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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
