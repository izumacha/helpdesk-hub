// tenantId → Tenant のリクエストスコープ共有キャッシュ。
//
// src/lib/tenant.ts (getCurrentTenantMode) と src/lib/tenant-plan.ts (resolveTenantPlanDetail)
// の両方が「tenantId から Tenant 本体を取得する」処理を必要とするため、独立したこのファイルに
// 切り出す。tenant.ts は auth() のフォールバック用に @/lib/auth (next-auth) を import しており、
// tenant-plan.ts がそこから getCachedTenant を import すると next-auth 一式まで芋づる式に
// バンドルされてしまい、@/lib/tenant-plan を importOriginal() で部分モックする既存テスト
// (例: tests/features/inbound-line-route.test.ts) が next-auth 内部の 'next/server' 解決に
// 失敗して壊れる。そのため next-auth 非依存のこの最小モジュールを両者の共有先にする。
import { cache } from 'react';
import { repos } from '@/data';
import type { Tenant } from '@/domain/types';

// cache() でラップし、同一リクエスト内で複数の呼び出し元 (layout の getCurrentTenantMode /
// resolveTenantPlan、各ページの直接取得) が同じ tenantId を引いても Tenant への冗長な
// SELECT を 1 回にまとめる。
export const getCachedTenant = cache(async (tenantId: string): Promise<Tenant | null> => {
  return repos.tenants.findById(tenantId);
});
