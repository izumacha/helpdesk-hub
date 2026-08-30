// Stripe の status + Price ID から課金プランを決める純粋ロジックのテスト。
//
// なぜユニットテストで固定するのか:
//   この判定は「テナントがどの機能を使えるか」を決める入口で、
//   `src/app/api/webhooks/stripe/route.ts` 経由で **課金プランの昇格・降格に直結**する。
//   にもかかわらず、これまでルート経由のテストしか無く（しかもそこでは判定自体を
//   モックで差し替えていた）、規則そのものは一度も検証されていなかった。
//   とくに「安全側に倒して free を返す」分岐は、正常な解約と区別がつかないまま
//   課金中のテナントを降格させうるため、境界値を明示的に固定しておく価値が高い。
//
// 環境変数について:
//   `STRIPE_PRICE_IDS` はモジュール読み込み時に `process.env` を読むので、
//   import より前に値を入れておく必要がある（後から差し替えても反映されない）。

import { describe, expect, it } from 'vitest';

// Price ID の対応表はモジュール評価時に固定されるため、import 前に環境変数を用意する
process.env.STRIPE_PRICE_STANDARD = 'price_standard_test';
process.env.STRIPE_PRICE_PRO = 'price_pro_test';

// 環境変数を入れ終えてから読み込む（静的 import だと巻き上げで先に評価されてしまう）
const { isActiveSubscriptionStatus, stripeStatusToPlan } = await import('@/lib/stripe');

describe('isActiveSubscriptionStatus', () => {
  // 課金が有効とみなすのは active（支払い済み）と trialing（試用期間中）の 2 つだけ
  it.each(['active', 'trialing'])('%s は有効な状態とみなす', (status) => {
    expect(isActiveSubscriptionStatus(status)).toBe(true);
  });

  // それ以外はすべて無効。空文字や未知の文字列も「不明なら無効」に倒す（§9 fail-closed）
  it.each(['past_due', 'canceled', 'incomplete', 'unpaid', 'paused', '', 'ACTIVE'])(
    '%s は有効な状態とみなさない',
    (status) => {
      expect(isActiveSubscriptionStatus(status)).toBe(false);
    },
  );
});

describe('stripeStatusToPlan', () => {
  // 有効なサブスクなら Price ID に対応するプランへ昇格する
  it('有効な状態で Pro の Price ID なら pro を返す', () => {
    expect(stripeStatusToPlan('active', 'price_pro_test')).toBe('pro');
  });

  it('有効な状態で Standard の Price ID なら standard を返す', () => {
    expect(stripeStatusToPlan('trialing', 'price_standard_test')).toBe('standard');
  });

  // status が無効なら、Price ID が何であってもプランを与えない（支払いが止まっている以上、
  // 正しい Price ID を持っていることは権限の根拠にならない）
  it('status が無効なら Pro の Price ID でも free を返す', () => {
    expect(stripeStatusToPlan('past_due', 'price_pro_test')).toBe('free');
  });

  // Price ID が空（環境変数未設定・ペイロード欠落）でも、空文字同士が一致して
  // 誤って昇格しないこと。ここが崩れると未課金テナントに Pro 権限が渡る
  it('Price ID が空なら free を返す（空文字同士の一致で昇格しない）', () => {
    expect(stripeStatusToPlan('active', '')).toBe('free');
  });

  // どのプランにも一致しない Price ID は安全側の free。
  // ただしこれは「正常な解約」と同じ戻り値になるため、呼び出し側（Webhook ルート）が
  // 異常としてログに出す責務を持つ — その挙動は tests/features/stripe-webhook-route.test.ts が固定する
  it('未知の Price ID は free を返す（安全側のフォールバック）', () => {
    expect(stripeStatusToPlan('active', 'price_not_configured')).toBe('free');
  });
});
