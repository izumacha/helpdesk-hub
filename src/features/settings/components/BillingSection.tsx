'use client';

// Phase 4 課金: サブスクリプションプランの確認とアップグレード/管理 UI。
// 管理者が現在のプランを確認し、Stripe Checkout または Customer Portal へ遷移するための
// Client Component。docs/smb-dx-pivot-plan.md §6「マネタイズ・販売戦略」

// React の状態・トランジションフック
import { useState, useTransition } from 'react';
// Stripe Checkout セッション作成 (新規登録・プラン変更)
import { createCheckoutSession } from '@/features/settings/actions/create-checkout-session';
// Stripe Customer Portal セッション作成 (プラン管理・解約・請求書確認)
import { createPortalSession } from '@/features/settings/actions/create-portal-session';
// プラン型とプランごとの上限値ヘルパー
import type { SubscriptionPlan } from '@/domain/types';
import { USER_LIMIT, getMonthlyTicketLimit } from '@/lib/plan-guard';

// 各プランの表示設定 (名称・月額・特徴)
const PLAN_INFO: Record<SubscriptionPlan, { label: string; price: string; features: string[] }> = {
  // 無料プラン: 最小構成でお試し
  free: {
    label: 'Free',
    price: '無料',
    features: [
      `メンバー ${USER_LIMIT.free} 名まで`,
      `月 ${getMonthlyTicketLimit('free')} 件まで`,
      'Lite モードのみ',
    ],
  },
  // スタンダードプラン: 中小企業向けの標準構成
  standard: {
    label: 'Standard',
    price: '月額 ¥4,980',
    features: [
      `メンバー ${USER_LIMIT.standard} 名まで`,
      '月間チケット無制限',
      'メール取り込み対応',
      'Lite モードフル機能',
    ],
  },
  // プロプラン: フル機能
  pro: {
    label: 'Pro',
    price: '月額 ¥14,800',
    features: [
      `メンバー ${USER_LIMIT.pro} 名まで`,
      '月間チケット無制限',
      'Pro モード (7 ステータス・SLA)',
      '監査ログ・LINE 連携',
      'メール取り込み対応',
    ],
  },
  // エンタープライズプラン: 個別見積 (無制限 + SSO + 監査強化)。Stripe 非経由で運用が手動設定
  enterprise: {
    label: 'Enterprise',
    price: '個別見積',
    features: [
      'メンバー無制限',
      '月間チケット無制限',
      'Pro モードの全機能',
      'SSO (SAML) シングルサインオン',
      '監査強化・SLA 契約',
    ],
  },
};

// 受け取る props
interface Props {
  // 現在のサブスクリプションプラン (契約プランそのもの。プラン名・機能一覧の表示に使う)
  currentPlan: SubscriptionPlan;
  // §7.2 Free trial 昇格後の実効プラン (トライアル対象外/終了済みなら currentPlan と同じ値)。
  // スタッフ人数が「実際に今適用されている上限」を超えているかの判定はこちらを使う
  // (トライアル中は Free の 3 名ではなく Standard の 10 名が適用されるため)
  effectivePlan: SubscriptionPlan;
  // Stripe Subscription の status 文字列 (null なら未登録)
  stripeStatus: string | null;
  // Stripe Customer ID の有無 (ポータルリンクを表示するかの判断に使う)
  hasStripeCustomer: boolean;
  // 現在のスタッフ人数 (agent/admin のみ)。Stripe ダウングレード後の上限超過検知に使う
  currentUserCount: number;
  // §7.2 Free trial の残り日数 (トライアル対象外/終了済みなら null)。
  // Date は RSC 境界を跨ぐ受け渡しを避けるため、サーバー側で日数に変換済みの値を受け取る
  trialDaysRemaining: number | null;
}

// サブスクリプション管理セクション (プラン表示 + アップグレード/管理ボタン)
export function BillingSection({
  currentPlan,
  effectivePlan,
  stripeStatus,
  hasStripeCustomer,
  currentUserCount,
  trialDaysRemaining,
}: Props) {
  // ボタン操作中のエラーメッセージ
  const [error, setError] = useState<string | null>(null);
  // Server Action の実行中フラグ (ボタン二重押し防止)
  const [isPending, startTransition] = useTransition();

  // Stripe Checkout へのリダイレクト (新規登録またはプラン変更)
  function handleUpgrade(plan: 'standard' | 'pro') {
    setError(null);
    startTransition(async () => {
      const result = await createCheckoutSession(plan);
      if (result.error) {
        // エラーを表示して中断
        setError(result.error);
        return;
      }
      // Stripe の支払いページへリダイレクト
      if (result.url) {
        window.location.href = result.url;
      }
    });
  }

  // Stripe Customer Portal へのリダイレクト (プラン変更・解約・請求書確認)
  function handleManage() {
    setError(null);
    startTransition(async () => {
      const result = await createPortalSession();
      if (result.error) {
        // エラーを表示して中断
        setError(result.error);
        return;
      }
      // Stripe のポータルページへリダイレクト
      if (result.url) {
        window.location.href = result.url;
      }
    });
  }

  // 現在のプラン情報を取り出す (プラン名・機能一覧は契約プランそのものを表示する。
  // トライアルで一時的に使える機能は上のトライアル案内バナーで別途伝える)
  const info = PLAN_INFO[currentPlan];
  // 現在のスタッフ人数が「実際に今適用されている上限」を超えているか (Stripe ポータルでの解約・
  // ダウングレード後も既存メンバーは自動では削除されないため、ここで検知して警告する)。
  // §7.2 Free trial 中は Standard 相当のシート数が適用される (checkSeatAvailability も
  // resolveEffectivePlan 経由で同じ判定をしている) ため、必ず effectivePlan の上限で判定する。
  // currentPlan (契約プランの Free) で判定すると、トライアル中で実際は上限内なのに
  // 誤って「超えています」と表示してしまう。
  // isUserLimitReached (>= 判定) は「招待をこれ以上発行できるか」の判定用であり、
  // ちょうど上限と同数 (例: Free で 3/3 名) は正常な「満枠」状態であって「超過」ではない。
  // そのまま使うと満枠なだけの通常テナントにも「超えています」という誤った警告が
  // 常時表示されてしまうため、ここでは厳密な超過 (>) のみを判定する
  const isOverUserLimit = currentUserCount > USER_LIMIT[effectivePlan];

  return (
    <div className="space-y-4">
      {/* エラーメッセージ */}
      {error && (
        <p
          role="alert"
          className="rounded-lg bg-rose-50 px-3 py-2.5 text-sm text-rose-700 ring-1 ring-rose-200"
        >
          {error}
        </p>
      )}

      {/* §7.2 Free trial 中の案内: Standard 相当の機能 (メール取り込み等) が利用可能なことと
          残り日数を伝える (trialDaysRemaining は対象外/終了済みなら null で非表示) */}
      {trialDaysRemaining !== null && (
        <p className="rounded-lg bg-teal-50 px-3 py-2.5 text-sm text-teal-800 ring-1 ring-teal-200">
          トライアル期間中です（残り {trialDaysRemaining} 日）。Standard
          相当の機能（メール取り込み等）を無料でお試しいただけます。
        </p>
      )}

      {/* メンバー上限超過の警告: ダウングレード後も既存メンバーはそのまま利用できるが、
          新規招待はプラン上限チェック (create-invitation.ts) でブロックされる。
          その理由が分かるよう admin にここで明示する (§9 セキュリティ: fail-safe に既存利用は止めない) */}
      {isOverUserLimit && (
        <p
          role="alert"
          className="rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-800 ring-1 ring-amber-200"
        >
          現在のスタッフ人数 ({currentUserCount} 名) が {PLAN_INFO[effectivePlan].label}{' '}
          プランの上限 ({USER_LIMIT[effectivePlan]} 名) を超えています。既存メンバーはそのまま
          利用できますが、新規メンバーの招待はできません。プランをアップグレードするか、
          メンバーを整理してください。
        </p>
      )}

      {/* 現在のプラン表示カード */}
      <div className="rounded-xl border border-teal-200 bg-teal-50/60 p-4">
        {/* プラン名と月額 */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold tracking-wide text-teal-600 uppercase">
              現在のプラン
            </p>
            <p className="mt-0.5 text-lg font-bold text-slate-900">{info.label}</p>
          </div>
          <p className="text-sm font-semibold text-slate-700">{info.price}</p>
        </div>
        {/* プランの機能一覧 */}
        <ul className="mt-3 space-y-1">
          {info.features.map((f) => (
            <li key={f} className="flex items-center gap-1.5 text-sm text-slate-600">
              {/* チェックアイコン */}
              <span className="text-teal-500" aria-hidden="true">
                ✓
              </span>
              {f}
            </li>
          ))}
        </ul>
        {/* Stripe のサブスクリプション状態を表示 (有料プランのみ) */}
        {stripeStatus && (
          <p className="mt-3 text-xs text-slate-500">
            Stripe ステータス: <span className="font-medium text-slate-700">{stripeStatus}</span>
          </p>
        )}
      </div>

      {/* アクションボタン群 */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Standard プランへアップグレード (現在 Free の場合のみ表示) */}
        {currentPlan === 'free' && (
          <button
            type="button"
            onClick={() => handleUpgrade('standard')}
            disabled={isPending}
            className="rounded-lg border border-teal-600 bg-white px-4 py-2 text-sm font-semibold text-teal-700 shadow-sm transition hover:bg-teal-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? '処理中…' : 'Standard にアップグレード'}
          </button>
        )}
        {/* Pro プランへアップグレード (Free または Standard の場合のみ表示)。
            Enterprise には下位プランへの「アップグレード」を出さない (誤ダウングレード防止) */}
        {(currentPlan === 'free' || currentPlan === 'standard') && (
          <button
            type="button"
            onClick={() => handleUpgrade('pro')}
            disabled={isPending}
            className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? '処理中…' : 'Pro にアップグレード'}
          </button>
        )}
        {/* Stripe ポータルへのリンク (Stripe Customer が存在する場合のみ表示) */}
        {hasStripeCustomer && (
          <button
            type="button"
            onClick={handleManage}
            disabled={isPending}
            className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-50"
          >
            {isPending ? '処理中…' : 'プランを管理 (請求書・解約)'}
          </button>
        )}
      </div>
      {/* 注記: Free プランへのダウングレードは Stripe ポータルから解約する */}
      <p className="text-xs text-slate-500">
        プランのダウングレードまたは解約は「プランを管理」から行ってください。
      </p>
      {/* Enterprise の案内 (Enterprise 以外のテナントに向けたアップセル導線) */}
      {currentPlan !== 'enterprise' && (
        <p className="text-xs text-slate-500">
          無制限のメンバー・SSO (SAML)・監査強化が必要な場合は Enterprise プラン (個別見積) を
          ご検討ください。導入のご相談はサポートまでお問い合わせください。
        </p>
      )}
    </div>
  );
}
