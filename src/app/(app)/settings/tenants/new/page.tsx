// 現在のセッション (ログイン情報) を取得
import { auth } from '@/lib/auth';
// 設定トップへ戻る導線
import Link from 'next/link';
// テナント作成フォーム (Client Component)
import { CreateTenantForm } from '@/features/settings/components/CreateTenantForm';

// /settings/tenants/new : 新しい組織 (テナント) と初代管理者を作成するページ (管理者専用)
export default async function NewTenantPage() {
  // セッション取得 (middleware で未ログインは弾かれている前提)
  const session = await auth();
  // 未ログイン or tenantId 不在なら何も描画しない (middleware が先に弾く想定の保険)
  if (!session?.user?.id || !session.user.tenantId) return null;

  // テナント作成は組織管理にあたるため管理者専用。admin 以外には権限なし表示を返す
  // (middleware は認証のみを担当するため、RBAC はページ側で明示的に強制する)
  if (session.user.role !== 'admin') {
    return (
      <div className="rounded-2xl bg-white py-20 text-center text-slate-400 ring-1 ring-slate-200">
        <p className="text-sm">この画面は管理者のみ利用できます。</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* パンくず兼戻る導線 */}
      <Link href="/settings" className="text-sm text-teal-700 hover:underline">
        ← 設定に戻る
      </Link>

      {/* ヘッダー: タイトル + 説明文 */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">新しい組織を作成</h1>
        <p className="mt-1 text-sm text-slate-500">
          別の組織（テナント）を作成し、その初代管理者を登録します。作成した組織は独立して動作します。
        </p>
      </div>

      {/* 作成フォーム本体 */}
      <section className="space-y-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
        <CreateTenantForm />
      </section>
    </div>
  );
}
