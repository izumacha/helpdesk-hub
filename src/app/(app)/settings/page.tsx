// 現在のセッション (ログイン情報) を取得
import { auth } from '@/lib/auth';
// 現在ログイン中のテナントの動作モード (lite | pro) を取得するヘルパー
import { getCurrentTenantMode } from '@/lib/tenant';
// モードの日本語ラベル (現在値の表示に使う)
import { TENANT_MODE_LABELS } from '@/lib/constants';
// Lite / Pro 切替フォーム (Client Component)
import { TenantModeForm } from '@/features/settings/components/TenantModeForm';

// /settings : テナント設定ページ (現状は Lite/Pro モードの切替のみ。管理者専用)
export default async function SettingsPage() {
  // セッション取得 (middleware で未ログインは弾かれている前提)
  const session = await auth();
  // 未ログイン or tenantId 不在なら何も描画しない (middleware が先に弾く想定の保険)
  if (!session?.user?.id || !session.user.tenantId) return null;

  // テナント全体の設定変更は管理者専用。admin 以外には権限なし表示を返す
  // (middleware は認証のみを担当するため、RBAC はページ側で明示的に強制する)
  if (session.user.role !== 'admin') {
    return (
      <div className="rounded-2xl bg-white py-20 text-center text-slate-400 ring-1 ring-slate-200">
        <p className="text-sm">この画面は管理者のみ利用できます。</p>
      </div>
    );
  }

  // 現在のテナントモード (lite | pro) を取得してフォームの初期値にする
  const mode = await getCurrentTenantMode(session.user.tenantId);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* ヘッダー: タイトル + 説明文 */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">設定</h1>
        <p className="mt-1 text-sm text-slate-500">
          組織全体の動作モードを切り替えます。変更はすべての利用者に反映されます。
        </p>
      </div>

      {/* 動作モード設定カード */}
      <section className="space-y-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
        <div>
          {/* セクション見出し */}
          <h2 className="text-base font-semibold text-slate-900">動作モード</h2>
          {/* 現在のモードを明示 (どちらが有効かをひと目で分かるように) */}
          <p className="mt-1 text-sm text-slate-500">
            現在のモード:{' '}
            <span className="font-medium text-teal-700">{TENANT_MODE_LABELS[mode]}</span>
          </p>
        </div>
        {/* 切替フォーム本体 (現在値を初期選択として渡す) */}
        <TenantModeForm current={mode} />
      </section>
    </div>
  );
}
