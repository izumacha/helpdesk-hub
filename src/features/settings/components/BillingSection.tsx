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
const PLAN_INFO: Record<
  SubscriptionPlan,
  { label: string; price: string; features: string[] }
> = {
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
};

// 受け取る props
interface Props {
  // 現在のサブスクリプションプラン
  currentPlan: SubscriptionPlan;
  // Stripe Subscription の status 文字列 (null なら未登録)
  stripeStatus: string | null;
  // Stripe Customer ID の有無 (ポータルリンクを表示するかの判断に使う)
  hasStripeCustomer: boolean;
}

// サブスクリプション管理セクション (プラン表示 + アップグレード/管理ボタン)
export function BillingSection({ currentPlan, stripeStatus, hasStripeCustomer }: Props) {
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

  // 現在のプラン情報を取り出す
  const info = PLAN_INFO[currentPlan];

  return (
    <div className="space-y-4">
      {/* エラーメッセージ */}
      {error && (
        <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2.5 text-sm text-rose-700 ring-1 ring-rose-200">
          {error}
        </p>
      )}

      {/* 現在のプラン表示カード */}
      <div className="rounded-xl border border-teal-200 bg-teal-50/60 p-4">
        {/* プラン名と月額 */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-teal-600">現在のプラン</p>
            <p className="mt-0.5 text-lg font-bold text-slate-900">{info.label}</p>
          </div>
          <p className="text-sm font-semibold text-slate-700">{info.price}</p>
        </div>
        {/* プランの機能一覧 */}
        <ul className="mt-3 space-y-1">
          {info.features.map((f) => (
            <li key={f} className="flex items-center gap-1.5 text-sm text-slate-600">
              {/* チェックアイコン */}
              <span className="text-teal-500" aria-hidden="true">✓</span>
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
        {/* Pro プランへアップグレード (Free または Standard の場合に表示) */}
        {currentPlan !== 'pro' && (
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
      <p className="text-xs text-slate-400">
        プランのダウングレードまたは解約は「プランを管理」から行ってください。
      </p>
    </div>
  );
}
