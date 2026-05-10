// データ層の Composition Root 経由でカテゴリ一覧を取得する (Prisma 直叩きを避ける)
import { repos } from '@/data';
// 新規チケット入力フォーム (Client Component)
import { TicketForm } from '@/features/tickets/components/TicketForm';

// /tickets/new : 新規チケット作成ページ (Server Component)
export default async function NewTicketPage() {
  // フォームのカテゴリ選択肢として、全カテゴリを名前順で取得 (port 経由)
  const categories = await repos.categories.list();

  return (
    // 中央寄せの幅 max-w-2xl コンテナ
    <div className="mx-auto max-w-2xl">
      {/* ページヘッダー: タイトル + サブテキスト */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">問い合わせ 新規登録</h1>
        <p className="mt-1 text-sm text-slate-500">
          内容はサポート担当者に通知され、対応状況を追跡できます。
        </p>
      </div>
      {/* 白カードに包んでフォームを描画 (健診の問診票のような落ち着き) */}
      <div className="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-100">
        <TicketForm categories={categories} />
      </div>
    </div>
  );
}
