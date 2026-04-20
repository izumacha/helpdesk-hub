// セッション (ログイン情報) 取得
import { auth } from '@/lib/auth';
// DB クライアント (Prisma)
import { prisma } from '@/lib/prisma';
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
  // 未ログインなら何も描画しない
  if (!session?.user?.id) return null;
  // 一般ユーザー (依頼者) は 404 で隠す
  if (!isAgent(session.user.role)) notFound();

  // FAQ 候補を新しい順で全件取得 (元チケットと作成者名を含む)
  const faqs = await prisma.faqCandidate.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      question: true,
      answer: true,
      status: true,
      ticket: { select: { id: true, title: true } },
      createdBy: { select: { name: true } },
    },
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">FAQ候補一覧</h1>

      {faqs.length === 0 ? (
        // 0 件時の空状態
        <div className="rounded-lg border border-dashed border-gray-300 py-16 text-center text-gray-400">
          FAQ候補はまだありません
        </div>
      ) : (
        // 1 件以上ある場合は順に列挙
        <div className="space-y-4">
          {faqs.map((faq) => (
            <div key={faq.id} className="rounded-lg bg-white p-5 shadow-sm">
              {/* 上段: ステータスバッジ + 元チケットへのリンク */}
              <div className="mb-2 flex items-center justify-between">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${FAQ_STATUS_COLORS[faq.status] ?? ''}`}
                >
                  {FAQ_STATUS_LABELS[faq.status] ?? faq.status}
                </span>
                <span className="text-xs text-gray-400">
                  登録者: {faq.createdBy.name} / 元チケット:{' '}
                  <a
                    href={`/tickets/${faq.ticket.id}`}
                    className="text-blue-600 hover:underline"
                  >
                    {faq.ticket.title}
                  </a>
                </span>
              </div>

              {/* 質問と回答本文 */}
              <h3 className="mb-1 font-semibold text-gray-800">Q. {faq.question}</h3>
              <p className="whitespace-pre-wrap text-sm text-gray-600">A. {faq.answer}</p>

              {/* Candidate 状態のときのみ「公開/却下」ボタンを表示 */}
              {faq.status === 'Candidate' && (
                <div className="mt-3 flex gap-2">
                  {/* 公開ボタン (アクションに引数をバインド) */}
                  <form action={updateFaqStatus.bind(null, faq.id, 'Published')}>
                    <button
                      type="submit"
                      className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
                    >
                      公開する
                    </button>
                  </form>
                  {/* 却下ボタン */}
                  <form action={updateFaqStatus.bind(null, faq.id, 'Rejected')}>
                    <button
                      type="submit"
                      className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
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
