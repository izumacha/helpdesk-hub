// セッションからログインユーザーの tenantId を取得するための NextAuth 関数
import { auth } from '@/lib/auth';
// Composition Root からテナント取得用リポジトリ束を取り込む
import { repos } from '@/data';
// テナントモード型 (lite | pro) をドメイン層から取り込む
import type { TenantMode } from '@/domain/types';

// 現在ログイン中のテナントの mode (lite | pro) を取得するヘルパー
// - 引数 tenantId が渡されればその値で Tenant を引く (page で既に session を取っているケース向けの最適化)
// - 引数が無ければ auth() でセッションを引き、その tenantId を使う
// - セッション無し / Tenant が見つからない場合は安全側に倒して 'lite' を返す (DB 既定値と一致)
export async function getCurrentTenantMode(tenantId?: string): Promise<TenantMode> {
  // 呼び出し側が tenantId を持っていれば二重に session を読まないようそのまま使う
  let resolvedTenantId = tenantId;
  // tenantId が渡っていない場合のみ NextAuth のセッションから引き出す
  if (!resolvedTenantId) {
    // セッションを取得 (未ログインなら null)
    const session = await auth();
    // セッションが無い / tenantId が無い場合は既定 mode (lite) を返して終了
    if (!session?.user?.tenantId) return 'lite';
    // セッションから取り出した tenantId を以降の処理で利用する
    resolvedTenantId = session.user.tenantId;
  }
  // Tenant リポジトリ (port 経由) で tenantId から Tenant 本体を取得
  const tenant = await repos.tenants.findById(resolvedTenantId);
  // Tenant が見つからなければ既定 mode (lite) にフォールバック (削除/不整合への防御)
  return tenant?.mode ?? 'lite';
}
