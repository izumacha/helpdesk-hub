// セッション (ログイン中ユーザー) 取得
import { auth } from '@/lib/auth';
// データ層の Composition Root 経由でカテゴリ一覧を取得する (Prisma 直叩きを避ける)
import { repos } from '@/data';
// 新規チケット入力フォーム (Client Component)
import { TicketForm } from '@/features/tickets/components/TicketForm';
// 現在ログイン中のテナントの動作モード (lite | pro) を取得するヘルパー
import { getCurrentTenantMode } from '@/lib/tenant';
// 監査で発見したギャップ対応: list/listByTenant は既定で表示用の上限 (200 件) しか返さない。
// 本フォームのプルダウンは全カテゴリ・全拠点が選択肢の前提のため、CSV インポートと同じ
// 網羅的な上限を明示的に渡す (未指定のままだと 201 件目以降が選べなくなる)
import { CATEGORY_LIST_MATCHING_LIMIT } from '@/data/ports/category-repository';
import { LOCATION_LIST_MATCHING_LIMIT } from '@/data/ports/location-repository';
// AI FAQ 自己解決 (§4.29): プランゲート (Pro 以上) と API キー構成の有無で提案 UI を出すか決める
import { isAiDeflectionAllowed } from '@/lib/plan-guard';
import { resolveTenantPlan } from '@/lib/tenant-plan';
import { isDeflectionConfigured } from '@/lib/deflection-llm';

// /tickets/new : 新規チケット作成ページ (Server Component)
export default async function NewTicketPage() {
  // セッション取得 (proxy で認証済みのはずだが防御的に確認)
  const session = await auth();
  // 未ログイン or tenantId 不在は描画しない (proxy が先に弾く想定)
  if (!session?.user?.id || !session.user.tenantId) return null;

  // セッションから tenantId を取り出し以降の port 呼び出しに伝搬する
  const tenantId = session.user.tenantId;
  // カテゴリ一覧・テナント mode・拠点一覧・実効プランを並列取得する
  const [categories, mode, locations, plan] = await Promise.all([
    repos.categories.list(tenantId, { limit: CATEGORY_LIST_MATCHING_LIMIT }),
    getCurrentTenantMode(tenantId),
    // Phase 4 多拠点: 拠点プルダウン用の一覧を取得する
    repos.locations.listByTenant(tenantId, { limit: LOCATION_LIST_MATCHING_LIMIT }),
    // §4.29: AI FAQ 自己解決のプランゲート判定用 (トライアル昇格を含む実効プラン)
    resolveTenantPlan(tenantId),
  ]);
  // AI FAQ 自己解決の提案 UI を有効にするか (Pro 以上 かつ API キー構成済み)。
  // サーバー側 (suggestFaqForDraft) でも同じゲートを強制するため、ここは無駄な呼び出しを避けるヒント
  const deflectionEnabled = isAiDeflectionAllowed(plan) && isDeflectionConfigured();

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
        {/* locations を渡すことで拠点プルダウンが表示される (登録なしなら非表示) */}
        <TicketForm
          categories={categories}
          locations={locations}
          mode={mode}
          deflectionEnabled={deflectionEnabled}
        />
      </div>
    </div>
  );
}
