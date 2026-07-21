// フォローアップ (2026-07-21): カテゴリの作成/更新 (create-category.ts / update-category.ts) は
// 設定画面の CategoriesSection を Pro モードのときだけ表示することで実質 Pro 専用にしているが、
// Server Action 自体は assertTenantAdmin() のみで mode を確認しておらず、UI 非表示に頼った認可に
// なっていた (§9 セキュリティ: 認可はサーバー側で強制する。UI を隠すだけに頼らない)。
// sso-context.ts の assertSsoConfigAdmin と同じ「共有プリミティブ + 機能固有ゲートを重ねる」設計で
// 一箇所に集約し、実装ドリフトを防ぐ。
//
// 削除 (delete-category.ts) はこのゲートを経由しない。assertSsoConfigOwner と同じ考え方で、
// Pro→Lite ダウングレード後に残ったカテゴリを片付ける操作まで塞いでしまわないようにするため。

// データ層の Composition Root
import { repos } from '@/data';
// 「ログイン済み・admin・自テナント」の共通プリミティブ
import { assertTenantAdmin, type TenantAdminGate } from '@/lib/tenant-admin-gate';

// カテゴリ管理ゲートの結果 (TenantAdminGate と同じ形状)
export type CategoryAdminGate = TenantAdminGate;

// カテゴリの作成/更新の前提 (ログイン済み・admin・Pro モード) をまとめて検証する
export async function assertCategoryManagementAdmin(): Promise<CategoryAdminGate> {
  // 共通プリミティブで「ログイン済み・admin・自テナント」を検証する
  const gate = await assertTenantAdmin();
  if (!gate.ok) return gate;
  // テナントを取得して mode が Pro か確認する (カテゴリは Pro モード専用の設定)
  const tenant = await repos.tenants.findById(gate.tenantId);
  if (!tenant) return { ok: false, error: 'テナント情報の取得に失敗しました' };
  if (tenant.mode !== 'pro') {
    return { ok: false, error: 'カテゴリ管理は Pro モードでのみ利用できます。' };
  }
  return gate;
}
