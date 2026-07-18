// CSV インポートページ (Phase 3 CSVインポート)
// エージェント / 管理者のみがアクセス可能なチケット一括取り込み画面

// セッション取得 (認可チェック用)
import { auth } from '@/lib/auth';
// リポジトリ束 (カテゴリ取得用)
import { repos } from '@/data';
// エージェント権限判定 (agent または admin のとき true)
import { isAgent } from '@/lib/role';
// CSV インポートフォーム (Client Component)
import { CsvImportForm } from '@/features/tickets/components/CsvImportForm';
// クライアント遷移付きリンク (一覧ページへ戻るボタン用)
import Link from 'next/link';
// 未ログイン / 権限不足時のリダイレクト
import { redirect } from 'next/navigation';
// 監査で発見したギャップ対応: list は既定で表示用の上限 (200 件) しか返さない。実際の
// インポート処理 (import-tickets.ts) は網羅的な上限 (CATEGORY_LIST_MATCHING_LIMIT) で
// カテゴリ名を解決するため、このプレビュー表示だけ 200 件で切れると実処理と一覧が食い違う
import { CATEGORY_LIST_MATCHING_LIMIT } from '@/data/ports/category-repository';

// チケット CSV インポートページ (Server Component)
export default async function TicketImportPage() {
  // セッション取得してログイン済みかを確認する
  const session = await auth();
  // 未ログイン、または tenantId 欠落の場合はログインページへリダイレクトする
  if (!session?.user?.id || !session.user.tenantId) {
    redirect('/login');
  }
  // エージェント / 管理者以外は一覧ページへリダイレクトする (依頼者はアクセス不可)
  if (!isAgent(session.user.role)) {
    redirect('/tickets');
  }

  // tenantId を使ってカテゴリ一覧を取得する (将来の列マッピング UI に備えた先行取得)
  const tenantId = session.user.tenantId;
  // カテゴリをリポジトリ経由で取得する (tenantId スコープ)。実際のインポート処理と
  // 同じ網羅的な上限を使い、プレビューと実処理の一覧が食い違わないようにする
  const categories = await repos.categories.list(tenantId, { limit: CATEGORY_LIST_MATCHING_LIMIT });

  return (
    <div className="space-y-6">
      {/* ページヘッダー: パンくずリスト + タイトル */}
      <div>
        {/* パンくずリスト: チケット一覧ページへ戻る */}
        <Link
          href="/tickets"
          className="text-sm text-teal-700 transition hover:underline"
        >
          ← チケット一覧
        </Link>
        {/* ページタイトル */}
        <h1 className="mt-2 text-2xl font-bold text-slate-900">CSV インポート</h1>
        {/* ページの説明文 */}
        <p className="mt-1 text-sm text-slate-500">
          CSV ファイルからチケットを一括で取り込みます。
        </p>
      </div>

      {/* CSV インポートフォーム (Client Component) */}
      <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
        {/* カテゴリ一覧を Props で渡す (将来の列マッピング UI 向け) */}
        <CsvImportForm categories={categories} />
      </div>
    </div>
  );
}
