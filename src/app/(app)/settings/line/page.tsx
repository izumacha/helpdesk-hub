// 現在のセッション (ログイン情報) を取得
import { auth } from '@/lib/auth';
// データ層の Composition Root (連携状態の取得に使う)
import { repos } from '@/data';
// LINE 連携の自己サービス UI (コード発行 / 解除)
import { LineLinkSection } from '@/features/settings/components/LineLinkSection';

// /settings/line : LINE 連携ページ。
// テナント設定 (/settings) は管理者専用だが、このページは「自分の LINE を自分のアカウントに紐付ける」
// 自己サービスなので requester を含む全ロールがアクセスできる (認証のみ要求)。
export default async function LineLinkPage() {
  // セッション取得 (middleware で未ログインは弾かれている前提)
  const session = await auth();
  // 未ログイン or tenantId 不在なら何も描画しない (middleware が先に弾く想定の保険)
  if (!session?.user?.id || !session.user.tenantId) return null;

  // 現在のユーザーを取得し、LINE 連携済みか (lineUserId が入っているか) を判定する
  const me = await repos.users.findById(session.user.id);
  // lineUserId が非 null・非空なら連携済みとみなす
  const connected = !!me?.lineUserId;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* ヘッダー: タイトル + 説明文 */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">LINE 連携</h1>
        <p className="mt-1 text-sm text-slate-500">
          LINE 公式アカウントとあなたのアカウントを連携すると、LINE から送った問い合わせを
          自分の問い合わせ一覧で確認・追跡できるようになります。
        </p>
      </div>

      {/* 連携設定カード */}
      <section className="space-y-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
        <div>
          {/* セクション見出し */}
          <h2 className="text-base font-semibold text-slate-900">LINE アカウントの連携</h2>
        </div>
        {/* 連携状態に応じたフォーム本体 (連携済み / 未連携で表示を切り替える) */}
        <LineLinkSection connected={connected} />
      </section>
    </div>
  );
}
