// DB クライアント (Prisma) でカテゴリ一覧を取得するために使用
import { prisma } from '@/lib/prisma';
// 新規チケット入力フォーム (Client Component)
import { TicketForm } from '@/features/tickets/components/TicketForm';

// /tickets/new : 新規チケット作成ページ (Server Component)
export default async function NewTicketPage() {
  // フォームのカテゴリ選択肢として、全カテゴリを名前順で取得
  const categories = await prisma.category.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });

  return (
    // 中央寄せの幅 max-w-2xl コンテナ
    <div className="mx-auto max-w-2xl">
      {/* ページタイトル */}
      <h1 className="mb-6 text-2xl font-bold text-gray-900">問い合わせ 新規登録</h1>
      {/* カードに包んでフォームを描画 */}
      <div className="rounded-lg bg-white p-6 shadow-sm">
        <TicketForm categories={categories} />
      </div>
    </div>
  );
}
