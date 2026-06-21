// 現在のセッション (ログイン情報) を取得
import { auth } from '@/lib/auth';
// 現在ログイン中のテナントの動作モード (lite | pro) を取得するヘルパー
import { getCurrentTenantMode } from '@/lib/tenant';
// クライアント遷移付きリンク (テナント作成画面への導線)
import Link from 'next/link';
// モードの日本語ラベル (現在値の表示に使う)
import { TENANT_MODE_LABELS } from '@/lib/constants';
// Lite / Pro 切替フォーム (Client Component)
import { TenantModeForm } from '@/features/settings/components/TenantModeForm';
// メンバー招待リンク発行フォーム (Client Component)
import { InviteForm } from '@/features/settings/components/InviteForm';
// Phase 4: Slack/Teams Webhook URL 設定フォーム (Client Component)
import { SlackWebhookForm } from '@/features/settings/components/SlackWebhookForm';
// Phase 4 多拠点: 拠点管理セクション (Client Component)
import { LocationsSection } from '@/features/settings/components/LocationsSection';
// Phase 4 課金: サブスクリプション管理セクション (Client Component)
import { BillingSection } from '@/features/settings/components/BillingSection';
// テナント情報取得 (slackWebhookUrl / 拠点一覧 / プラン情報の初期値を渡すため)
import { repos } from '@/data';

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
  // Phase 4: テナント情報と拠点一覧を並列取得する
  const [tenant, locations] = await Promise.all([
    // テナント情報 (slackWebhookUrl / プラン / Stripe 情報の現在値を取得)
    repos.tenants.findById(session.user.tenantId),
    // 拠点一覧 (LocationsSection の初期値として渡す)
    repos.locations.listByTenant(session.user.tenantId),
  ]);

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

      {/* メンバー招待カード */}
      <section className="space-y-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
        <div>
          {/* セクション見出し */}
          <h2 className="text-base font-semibold text-slate-900">メンバーを招待</h2>
          {/* 説明: リンクを発行して共有する運用を伝える */}
          <p className="mt-1 text-sm text-slate-500">
            招待リンクを発行して共有すると、相手は組織のメンバーとして参加できます。
          </p>
        </div>
        {/* 招待リンク発行フォーム本体 */}
        <InviteForm />
      </section>

      {/* Phase 4: Slack / Teams 外部通知カード */}
      <section className="space-y-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
        <div>
          {/* セクション見出し */}
          <h2 className="text-base font-semibold text-slate-900">Slack / Teams 通知</h2>
          {/* 説明: どのような通知が届くかを伝える */}
          <p className="mt-1 text-sm text-slate-500">
            Slack または Microsoft Teams の Incoming Webhook URL を設定すると、
            問い合わせの作成・状況変更・コメント追加のタイミングで自動通知が届きます。
            空欄で保存すると通知が無効になります。
          </p>
        </div>
        {/* Webhook URL 設定フォーム (現在の URL を初期値として渡す) */}
        <SlackWebhookForm current={tenant?.slackWebhookUrl ?? null} />
      </section>

      {/* Phase 4 多拠点: 拠点管理カード */}
      <section className="space-y-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
        <div>
          {/* セクション見出し */}
          <h2 className="text-base font-semibold text-slate-900">拠点・店舗管理</h2>
          {/* 説明: 拠点を登録すると問い合わせ票で場所を選べる */}
          <p className="mt-1 text-sm text-slate-500">
            店舗・工場・支店などの拠点を登録すると、問い合わせを受け付ける際に場所を選択できます。
            拠点を削除しても、紐づく問い合わせのデータは消えず拠点欄が空になります。
          </p>
        </div>
        {/* 拠点一覧と追加フォーム (初期値をサーバーから渡す) */}
        <LocationsSection locations={locations} />
      </section>

      {/* Phase 4 課金: サブスクリプション管理カード */}
      <section className="space-y-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
        <div>
          {/* セクション見出し */}
          <h2 className="text-base font-semibold text-slate-900">課金プラン</h2>
          {/* 説明: 現在プランの確認とアップグレードを案内する */}
          <p className="mt-1 text-sm text-slate-500">
            現在の料金プランを確認し、アップグレードや解約の管理ができます。
            Standard・Pro へのアップグレードは Stripe の安全な決済ページに移動します。
          </p>
        </div>
        {/* プラン情報と操作ボタン */}
        <BillingSection
          currentPlan={tenant?.subscriptionPlan ?? 'free'}
          stripeStatus={tenant?.stripeSubscriptionStatus ?? null}
          hasStripeCustomer={!!tenant?.stripeCustomerId}
        />
      </section>

      {/* テナント (組織) 作成カード */}
      <section className="space-y-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
        <div>
          {/* セクション見出し */}
          <h2 className="text-base font-semibold text-slate-900">新しい組織を作成</h2>
          {/* 説明: 運用者が別組織を立ち上げる導線 */}
          <p className="mt-1 text-sm text-slate-500">
            別の組織（テナント）を新規に作成し、その初代管理者を登録します。
          </p>
        </div>
        {/* テナント作成フォームへの導線 (別ページ) */}
        <Link
          href="/settings/tenants/new"
          className="inline-block rounded-lg border border-teal-300 bg-white px-4 py-2 text-sm font-semibold text-teal-800 transition hover:bg-teal-50"
        >
          組織を作成する
        </Link>
      </section>
    </div>
  );
}
