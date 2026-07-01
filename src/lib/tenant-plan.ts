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

// 指定テナントの現在の課金プランを返す。テナントが見つからない場合は 'free' として扱う
// (fail-closed: 存在しない/取得できないテナントに Pro/Enterprise 限定機能を渡さない)。
export async function resolveTenantPlan(tenantId: string): Promise<SubscriptionPlan> {
  // テナントをリポジトリ経由で取得する
  const tenant = await repos.tenants.findById(tenantId);
  // 見つからなければ 'free' にフォールバックする
  return tenant?.subscriptionPlan ?? 'free';
}
