// 現在のセッション (ログイン情報) を取得
import { auth } from '@/lib/auth';
// tenantId → Tenant のリクエストスコープ共有キャッシュ。(app)/layout.tsx 等と同じキャッシュ
// 経由でテナント本体を取得し、同一リクエスト内での冗長な Tenant SELECT を避ける
import { getCachedTenant } from '@/lib/tenant-cache';
// クライアント遷移付きリンク (テナント作成画面への導線)
import Link from 'next/link';
// モードの日本語ラベル (現在値の表示に使う)
import { TENANT_MODE_LABELS } from '@/lib/constants';
// Lite / Pro 切替フォーム (Client Component)
import { TenantModeForm } from '@/features/settings/components/TenantModeForm';
// メンバー招待リンク発行フォーム (Client Component)
import { InviteForm } from '@/features/settings/components/InviteForm';
// Phase 4: Slack / Teams / Chatwork 通知チャネル設定フォーム (Client Component)
import { NotificationChannelsForm } from '@/features/settings/components/NotificationChannelsForm';
// Phase 4 多拠点: 拠点管理セクション (Client Component)
import { LocationsSection } from '@/features/settings/components/LocationsSection';
// Phase 4 課金: サブスクリプション管理セクション (Client Component)
import { BillingSection } from '@/features/settings/components/BillingSection';
// Phase 4 Enterprise: SAML SSO 設定セクション (Client Component)
import { SsoConfigSection } from '@/features/settings/components/SsoConfigSection';
// Phase 2 フォローアップ: テナント単位の LINE 連携設定セクション (Client Component)
import { LineConfigSection } from '@/features/settings/components/LineConfigSection';
// テナント情報取得 (slackWebhookUrl / 拠点一覧 / プラン情報の初期値を渡すため)
import { repos } from '@/data';
// プランゲート: Enterprise のみ SSO、Pro/Enterprise のみ LINE 連携、Standard 以上のみ
// メール取り込みを表示する。resolveEffectivePlan は §7.2 Free trial 中の実効プラン
// (Standard 相当) を解決する唯一の判定ロジック (SSOT)。トライアル中かどうかの判定を
// ここで再実装しない
import {
  isEmailInboundAllowed,
  isLineIntegrationAllowed,
  isSsoAllowed,
  resolveEffectivePlan,
} from '@/lib/plan-guard';
// SSO の SP エンドポイント URL を組み立てるヘルパー
import { buildSpUrls } from '@/lib/saml';
// アプリの公開ベース URL を解決するヘルパー (SP URL の組み立てに使う)
import { resolveAppBaseUrl } from '@/lib/app-url';
// メール取り込み用の転送先アドレスを組み立てるヘルパー (取り込みトークン + 配信ドメイン)
import { buildInboundAddress } from '@/lib/inbound-email';

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

  // Phase 4: テナント情報・拠点一覧・現在のスタッフ人数を並列取得する
  const [tenant, locations, currentUserCount] = await Promise.all([
    // テナント情報 (slackWebhookUrl / プラン / Stripe 情報の現在値を取得)。共有キャッシュ経由
    // にすることで、同一リクエスト内の (app)/layout.tsx (mode/plan 解決) と Tenant SELECT を共有する
    getCachedTenant(session.user.tenantId),
    // 拠点一覧 (LocationsSection の初期値として渡す)
    repos.locations.listByTenant(session.user.tenantId),
    // 現在のスタッフ人数 (agent/admin のみ)。Stripe ダウングレード後にプラン上限を
    // 超えていないかを BillingSection で警告表示するために使う
    repos.users.countByTenant(session.user.tenantId),
  ]);
  // 現在のテナントモード (lite | pro)。上で既に取得済みの tenant から導出する
  // (getCurrentTenantMode を別途呼ぶと同じ Tenant 行を再取得する不要な関数呼び出しになるため、
  // このページでは他のテナント項目 (subscriptionPlan 等) と同じ ?? フォールバック方式に揃える)
  const mode = tenant?.mode ?? 'lite';

  // Phase 4 Enterprise: SSO は Enterprise プランのみ、Phase 2 フォローアップ: LINE 連携は
  // Pro / Enterprise プランのみ新規設定・再設定が可能。ただし既存設定はプラン降格後も
  // 削除だけはできる必要があるため (プラン不問の削除ゲート。line-config-context.ts /
  // sso-context.ts 参照)、設定の有無自体はプランに関わらず常に取得する。
  const ssoAllowed = isSsoAllowed(tenant?.subscriptionPlan ?? 'free');
  const lineAllowed = isLineIntegrationAllowed(tenant?.subscriptionPlan ?? 'free');
  // §7.2 Free trial 中の実効プラン (Standard 相当への昇格を含む)。契約プラン自体は
  // subscriptionPlan のままなので、スタッフ上限の超過判定など「今実際に適用されている上限」を
  // 見る箇所は必ずこちらを使う (BillingSection の isOverUserLimit 等)
  const now = new Date();
  const effectivePlan = resolveEffectivePlan(
    tenant?.subscriptionPlan ?? 'free',
    tenant?.trialEndsAt ?? null,
    now,
  );
  // トライアル中かどうかは「契約プランが free なのに実効プランがそれと異なる」ことで判定する
  // (resolveEffectivePlan は free + トライアル有効期間中のみ 'standard' を返すため、
  // trialEndsAt > now を再度ここで比較しない = SSOT を重複させない)
  const isTrialActive = tenant?.subscriptionPlan === 'free' && effectivePlan !== 'free';
  // §7.2 Free trial の残り日数 (対象外/終了済みなら null)。Date を Client Component へ直接
  // 渡すのは避け、ここで日数に変換してから BillingSection に渡す
  const trialDaysRemaining =
    isTrialActive && tenant?.trialEndsAt
      ? Math.ceil((tenant.trialEndsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
      : null;
  const [ssoConfig, lineConfig] = await Promise.all([
    repos.ssoConfigs.findByTenant(session.user.tenantId),
    repos.lineConfigs.findByTenant(session.user.tenantId),
  ]);
  // SP の各 URL を組み立てる (Enterprise のとき、またはプラン降格後も既存設定の削除
  // 画面を出すために ssoConfig が残っているときに使う)
  const spUrls =
    ssoAllowed || ssoConfig ? buildSpUrls(resolveAppBaseUrl(), session.user.tenantId) : null;
  // Webhook 受信 URL (LINE Developers コンソールに登録する値)
  const lineWebhookUrl = `${resolveAppBaseUrl()}/api/inbound/line`;

  // §7.1 オンボーディング「専用のメール転送先を表示する」(Standard 以上、Free trial 中も含む)。
  // ダッシュボードの「はじめかた」案内・新規テナントのサンプルチケット本文は、この画面に転送先が
  // 表示されている前提の文言になっているため、ここで実際に表示する (回帰防止: 監査で発見された
  // 「案内文言はあるのに表示箇所が存在しない」不整合)
  const emailInboundAllowed = isEmailInboundAllowed(effectivePlan);
  // 配信ドメイン (INBOUND_EMAIL_DOMAIN) が未設定の環境では組み立てられないため null のままにする
  const inboundEmailDomain = process.env.INBOUND_EMAIL_DOMAIN?.trim() || null;
  // テナント固有の inboundToken と配信ドメインが両方揃ったときだけ転送先アドレスを組み立てる
  // (どちらか一方でも欠けていれば表示できないので null のままにする)
  const inboundEmailAddress =
    tenant?.inboundToken && inboundEmailDomain
      ? buildInboundAddress(tenant.inboundToken, inboundEmailDomain)
      : null;
  // アドレスが組み立てられない場合の原因は 2 通りある (このテナント固有の inboundToken 未発行 か、
  // 環境側の INBOUND_EMAIL_DOMAIN 未設定か) ので、案内メッセージを取り違えないよう区別する。
  // inboundToken は新規テナント作成時 (create-tenant.ts) にのみ自動発行され、それ以前に作成された
  // テナントには自動付与されない (20260619000000_add_tenant_inbound_token マイグレーション参照) ため
  // 実運用でも起こりうる。'domain' | 'token' の型は下の三項演算子の分岐だけで使う一時的なラベルの
  // ため、他ファイルと共有する定数化はせずリテラル型のまま扱う (§6 の「共有すべき値」には該当しない)
  const inboundEmailUnavailableReason: 'domain' | 'token' = tenant?.inboundToken
    ? 'domain' // トークンはあるがドメイン未設定
    : 'token'; // このテナントにトークン自体が未発行

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

      {/* メール取り込みカード (Standard 以上。Free trial 中も実効プランで許可される)。
          §7.1 オンボーディング手順4「専用のメール転送先を表示する」に対応する */}
      {emailInboundAllowed && (
        <section className="space-y-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
          <div>
            {/* セクション見出し */}
            <h2 className="text-base font-semibold text-slate-900">メール取り込み</h2>
            {/* 説明: 下記アドレスへ転送するとチケット化される旨を伝える */}
            <p className="mt-1 text-sm text-slate-500">
              今まで使っているメールアドレス宛の問い合わせを、下記の専用アドレスへ自動転送すると
              自動でチケットが作成されます。Gmail・Outlook の自動転送設定の手順は
              <Link
                href="/help/email-integration"
                className="text-teal-700 underline underline-offset-2 hover:text-teal-800"
              >
                ヘルプページ
              </Link>
              をご覧ください。
            </p>
          </div>
          {inboundEmailAddress ? (
            // 転送先アドレス (コピーしやすいよう等幅フォントで表示。LineConfigSection の
            // Webhook URL 表示と同じスタイルに揃える)
            <p className="rounded bg-slate-50 px-2 py-1 font-mono text-xs break-all text-slate-700 ring-1 ring-slate-200">
              {inboundEmailAddress}
            </p>
          ) : inboundEmailUnavailableReason === 'domain' ? (
            // INBOUND_EMAIL_DOMAIN が未設定の環境向けの案内 (運用者向け。秘密情報は含まない)
            <p className="rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-800 ring-1 ring-amber-200">
              メール取り込み用のドメインが未設定のため、転送先アドレスを表示できません。
              運用者に環境変数 (INBOUND_EMAIL_DOMAIN) の設定を確認してください。
            </p>
          ) : (
            // このテナントに inboundToken が未発行の場合の案内 (マイグレーション前から存在する
            // テナント等、create-tenant.ts の自動発行を経ていないケース)
            <p className="rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-800 ring-1 ring-amber-200">
              このテナントには転送先アドレスが未発行です。サポートまでお問い合わせください。
            </p>
          )}
        </section>
      )}

      {/* Phase 4: Slack / Teams / Chatwork 外部通知カード */}
      <section className="space-y-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
        <div>
          {/* セクション見出し */}
          <h2 className="text-base font-semibold text-slate-900">外部通知連携</h2>
          {/* 説明: どのような通知が届くかを伝える */}
          <p className="mt-1 text-sm text-slate-500">
            Slack・Microsoft Teams・Chatwork を設定すると、 問い合わせの状況変更などの
            タイミングで自動通知が届きます。設定したチャネルすべてに送信されます。
            各欄を空欄で保存すると、そのチャネルの通知が無効になります。
          </p>
        </div>
        {/* 通知チャネル設定フォーム (現在の各チャネル値を初期値として渡す) */}
        <NotificationChannelsForm
          slackWebhookUrl={tenant?.slackWebhookUrl ?? null}
          teamsWebhookUrl={tenant?.teamsWebhookUrl ?? null}
          chatworkApiToken={tenant?.chatworkApiToken ?? null}
          chatworkRoomId={tenant?.chatworkRoomId ?? null}
        />
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
            現在の料金プランを確認し、アップグレードや解約の管理ができます。 Standard・Pro
            へのアップグレードは Stripe の安全な決済ページに移動します。
          </p>
        </div>
        {/* プラン情報と操作ボタン */}
        <BillingSection
          currentPlan={tenant?.subscriptionPlan ?? 'free'}
          effectivePlan={effectivePlan}
          stripeStatus={tenant?.stripeSubscriptionStatus ?? null}
          hasStripeCustomer={!!tenant?.stripeCustomerId}
          currentUserCount={currentUserCount}
          trialDaysRemaining={trialDaysRemaining}
        />
      </section>

      {/* Phase 4 Enterprise: SAML SSO 設定カード (Enterprise プランで表示。プラン降格後も
          既存設定が残っていれば削除だけできるよう表示を続ける) */}
      {spUrls && (
        <section className="space-y-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
          <div>
            {/* セクション見出し */}
            <h2 className="text-base font-semibold text-slate-900">
              シングルサインオン (SAML SSO)
            </h2>
            {/* 説明: Enterprise 向けの SSO 設定であることを伝える */}
            <p className="mt-1 text-sm text-slate-500">
              社内の IdP (Okta・Microsoft Entra ID・Google Workspace など) と SAML 連携し、
              メンバーが SSO でログインできるようにします。Enterprise プラン限定の機能です。
              ログインできるのは、組織に既に登録済みのメンバーのみです。
            </p>
          </div>
          {/* SSO 設定フォームと SP 情報 (現在の設定と SP URL を渡す)。プラン降格後は
              planAllowed=false を渡し、再設定フォームを隠して削除だけ可能にする */}
          <SsoConfigSection
            config={
              ssoConfig
                ? {
                    idpEntityId: ssoConfig.idpEntityId,
                    idpSsoUrl: ssoConfig.idpSsoUrl,
                    idpX509Cert: ssoConfig.idpX509Cert,
                    enabled: ssoConfig.enabled,
                  }
                : null
            }
            sp={spUrls}
            planAllowed={ssoAllowed}
          />
        </section>
      )}

      {/* Phase 2 フォローアップ: LINE 公式アカウント連携設定カード (Pro/Enterprise プランで表示。
          プラン降格後も既存設定が残っていれば削除だけできるよう表示を続ける) */}
      {(lineAllowed || lineConfig) && (
        <section className="space-y-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
          <div>
            {/* セクション見出し */}
            <h2 className="text-base font-semibold text-slate-900">LINE 公式アカウント連携</h2>
            {/* 説明: テナント単位の LINE チャネル設定であることを伝える */}
            <p className="mt-1 text-sm text-slate-500">
              LINE 公式アカウントに送られたメッセージを問い合わせとして取り込み、担当者の返信を LINE
              へ届けます。LINE Developers コンソールで発行したチャネル情報を設定してください。
            </p>
          </div>
          {/* LINE 連携設定フォーム (秘密情報は渡さず botUserId のみ渡す。§9 参照)。プラン降格後は
              planAllowed=false を渡し、再設定フォームを隠して削除だけ可能にする */}
          <LineConfigSection
            config={lineConfig ? { botUserId: lineConfig.botUserId } : null}
            webhookUrl={lineWebhookUrl}
            planAllowed={lineAllowed}
          />
        </section>
      )}

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
