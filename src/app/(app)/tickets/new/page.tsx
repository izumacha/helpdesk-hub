// セッション (ログイン中ユーザー) 取得
import { auth } from '@/lib/auth';
// データ層の Composition Root 経由でカテゴリ一覧を取得する (Prisma 直叩きを避ける)
import { repos } from '@/data';
// 新規チケット入力フォーム (Client Component)
import { TicketForm } from '@/features/tickets/components/TicketForm';
// 現在ログイン中のテナントの動作モード (lite | pro) を取得するヘルパー
import { getCurrentTenantMode } from '@/lib/tenant';

// /tickets/new : 新規チケット作成ページ (Server Component)
export default async function NewTicketPage() {
  // セッション取得 (middleware で認証済みのはずだが防御的に確認)
  const session = await auth();
  // 未ログイン or tenantId 不在は描画しない (middleware が先に弾く想定)
  if (!session?.user?.id || !session.user.tenantId) return null;

  // セッションから tenantId を取り出し以降の port 呼び出しに伝搬する
  const tenantId = session.user.tenantId;
  // カテゴリ一覧とテナント mode を並列取得 (Lite なら mode によって UI を切替)
  const [categories, mode] = await Promise.all([
    repos.categories.list(tenantId),
    getCurrentTenantMode(tenantId),
  ]);

  return (
    // 中央寄せの幅 max-w-2xl コンテナ
    <div className="mx-auto max-w-2xl">
      {/* ページヘッダー: タイトル + サブテキスト (Lite/Pro でサブテキストを切替) */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">問い合わせ 新規登録</h1>
        <p className="mt-1 text-sm text-slate-500">
          {mode === 'lite'
            ? '件名・内容・期限だけで登録できます。'
            : '内容はサポート担当者に通知され、対応状況を追跡できます。'}
        </p>
      </div>
      {/* 白カードに包んでフォームを描画 (モバイルは余白を控えめに) */}
      <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100 sm:p-8">
        <TicketForm categories={categories} mode={mode} />
      </div>
    </div>
  );
}
