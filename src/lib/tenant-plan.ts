// テナントの現在プランを解決する共通ヘルパー。
//
// audit ページ・updateTenantMode・LINE 連携コード発行など、複数の Server Action / ページで
// 「テナントを読み込み、見つからなければ (または未取得なら) free 扱いにする」という同じ処理が
// 個別に書かれていたため 1 か所に集約する。src/lib/plan-guard.ts は DB に依存しない純粋関数のみを
// 置く方針 (tests/plan-guard.test.ts が @/data をモックせず素の関数として検証しているため) なので、
// DB 参照を伴うこのヘルパーは別ファイルに分離する
// (src/lib/sso-context.ts が isSsoAllowed の上にテナント参照を重ねているのと同じ考え方)。

// データ層の Composition Root (Prisma 直叩きを避ける入口)
import { repos } from '@/data';
// 課金プランの型
import type { SubscriptionPlan } from '@/domain/types';
// 月間チケット上限の判定ヘルパー (プランごとの上限値は plan-guard.ts が単一の源)
import { getMonthlyTicketLimit } from '@/lib/plan-guard';

// 指定テナントの現在の課金プランを返す。テナントが見つからない場合は 'free' として扱う
// (fail-closed: 存在しない/取得できないテナントに Pro/Enterprise 限定機能を渡さない)。
export async function resolveTenantPlan(tenantId: string): Promise<SubscriptionPlan> {
  // テナントをリポジトリ経由で取得する
  const tenant = await repos.tenants.findById(tenantId);
  // 見つからなければ 'free' にフォールバックする
  return tenant?.subscriptionPlan ?? 'free';
}

// 月間チケット起票数の残枠を表す (Web フォーム・CSV インポート・メール/LINE 取り込みが共有する)
export interface MonthlyTicketQuota {
  limited: boolean; // 上限のあるプランか (無制限プランなら false)
  limit: number; // 上限件数 (無制限なら -1。表示用に plan-guard.ts の規約をそのまま流用)
  remaining: number; // 今すぐ作成できる残り件数 (無制限なら Infinity)
}

// 指定テナントの当月チケット起票の残枠を取得する。
// Web フォーム (POST /api/tickets) だけでなく、CSV インポート・メール取り込み・LINE 取り込みなど
// チケットを作成する全ての入口で同じ判定を使うための共通ヘルパー (§6.1 料金プランの月間上限)。
// plan を既に把握している呼び出し側は渡せる (二重の tenant 取得を避ける)。
export async function getMonthlyTicketQuota(
  tenantId: string,
  plan?: SubscriptionPlan,
): Promise<MonthlyTicketQuota> {
  // プラン未指定なら解決する
  const resolvedPlan = plan ?? (await resolveTenantPlan(tenantId));
  // このプランの月間上限を取得する (-1 = 無制限)
  const limit = getMonthlyTicketLimit(resolvedPlan);
  // 無制限プランは DB 集計を行わず即座に返す (不要なクエリを避ける)
  if (limit === -1) {
    return { limited: false, limit: -1, remaining: Infinity };
  }
  // 当月の起票数をカウントする (現在月の開始日時を UTC で計算)
  const now = new Date();
  // 月初 00:00:00.000 (UTC) を起点にする
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  // 当月起票済み件数をカウントする (tenantId スコープ + createdAfter フィルター)
  const currentCount = await repos.tickets.count({ createdAfter: monthStart }, tenantId);
  // 残枠は 0 未満にならないようクランプする
  return { limited: true, limit, remaining: Math.max(0, limit - currentCount) };
}
