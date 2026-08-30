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
//   ただし vitest はモジュールレジストリこそファイル単位で分けるが `process.env` は
//   ワーカープロセスで共有されるため、素の代入だと**後続のテストファイルへ漏れる**。
//   実行順で緑にも赤にもなる検出網を作らないよう、`vi.stubEnv` で入れて最後に必ず戻す。

import { afterAll, describe, expect, it, vi } from 'vitest';

// Price ID の対応表はモジュール評価時に固定されるため、import 前に環境変数を用意する
vi.stubEnv('STRIPE_PRICE_STANDARD', 'price_standard_test');
vi.stubEnv('STRIPE_PRICE_PRO', 'price_pro_test');

// 環境変数を入れ終えてから読み込む（静的 import だと巻き上げで先に評価されてしまう）
const { isActiveSubscriptionStatus, pickKnownPriceId, stripeStatusToPlan } =
  await import('@/lib/stripe');

// pickKnownPriceId に渡す対応表 (この関数は純粋関数で、対応表を引数で受け取る)
const 対応表 = { standard: 'price_standard_test', pro: 'price_pro_test' } as const;

// 差し替えた環境変数を元へ戻し、同じワーカーで動く後続のテストファイルへ持ち越さない
afterAll(() => {
  vi.unstubAllEnvs();
});

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
    expect(stripeStatusToPlan('active', 'price_pro_test', 対応表)).toBe('pro');
  });

  it('有効な状態で Standard の Price ID なら standard を返す', () => {
    expect(stripeStatusToPlan('trialing', 'price_standard_test', 対応表)).toBe('standard');
  });

  // status が無効なら、Price ID が何であってもプランを与えない（支払いが止まっている以上、
  // 正しい Price ID を持っていることは権限の根拠にならない）
  it('status が無効なら Pro の Price ID でも free を返す', () => {
    expect(stripeStatusToPlan('past_due', 'price_pro_test', 対応表)).toBe('free');
  });

  // Price ID が空（環境変数未設定・ペイロード欠落）でも、空文字同士が一致して
  // 誤って昇格しないこと。ここが崩れると未課金テナントに Pro 権限が渡る
  it('Price ID が空なら free を返す（空文字同士の一致で昇格しない）', () => {
    expect(stripeStatusToPlan('active', '', 対応表)).toBe('free');
  });

  // どのプランにも一致しない Price ID は安全側の free。
  // ただしこれは「正常な解約」と同じ戻り値になるため、呼び出し側（Webhook ルート）が
  // 異常としてログに出す責務を持つ — その挙動は tests/features/stripe-webhook-route.test.ts が固定する
  it('未知の Price ID は free を返す（安全側のフォールバック）', () => {
    expect(stripeStatusToPlan('active', 'price_not_configured', 対応表)).toBe('free');
  });
});

describe('pickKnownPriceId', () => {
  // サブスクは座席追加や従量課金のアドオンで複数 item を持ち、items の並び順は保証されない。
  // 先頭を無条件に使うと、アドオンの ID を拾って本来 Pro の契約を「解決できない」と誤判定する
  it('既知プランの Price ID を、並び順によらず選ぶ', () => {
    expect(pickKnownPriceId(['price_addon', 'price_pro_test'], 対応表)).toBe('price_pro_test');
  });

  // standard と pro を同時に持つサブスク (プラン変更中の按分など) では、配列順で結果が
  // 揺れないよう上位プラン (pro) を優先する。並び順は保証されないので、ここが順序依存だと
  // 同じサブスクが再配信のたびに pro→standard へ降格しうる
  it.each([
    [['price_standard_test', 'price_pro_test']],
    [['price_pro_test', 'price_standard_test']],
  ])('standard と pro を両方持つときは並び順によらず pro を選ぶ (%s)', (ids) => {
    expect(pickKnownPriceId(ids, 対応表)).toBe('price_pro_test');
  });

  // price が展開されていない item が先頭に来ても、実際に届いた ID を落とさない
  // (ここで空文字を返すと、原因調査のログから本物の Price ID が消える)
  it('空の Price ID は飛ばして、空でない最初の値を返す', () => {
    expect(pickKnownPriceId(['', 'price_legacy'], 対応表)).toBe('price_legacy');
  });

  // 一致するものが無ければ先頭を返す。素の値を返すのは、原因調査でどの ID が来ていたかを
  // ログに見せるため (ここで空文字に潰すと調査の手がかりが消える)
  it('既知プランに一致しなければ先頭の Price ID を返す', () => {
    expect(pickKnownPriceId(['price_unknown_a', 'price_unknown_b'], 対応表)).toBe(
      'price_unknown_a',
    );
  });

  // 対応表が未設定 (空文字) のとき、空文字同士が一致して「既知」と誤判定しないこと。
  // ここが崩れると、未設定の環境で空の Price ID がプラン扱いされて誤って昇格する。
  // 返る値は診断用の素の ID (price_x) で、これが「既知」を意味しないことは
  // stripeStatusToPlan 側が同じ対応表で free と判定することで担保される
  it('対応表が未設定でも空文字を既知として扱わない', () => {
    const 未設定の対応表 = { standard: '', pro: '' } as const;
    expect(pickKnownPriceId(['', 'price_x'], 未設定の対応表)).toBe('price_x');
    expect(stripeStatusToPlan('active', 'price_x', 未設定の対応表)).toBe('free');
  });

  // items が空 (ペイロード欠落) でも例外にせず空文字へ倒す
  it('Price ID が 1 つも無ければ空文字を返す', () => {
    expect(pickKnownPriceId([], 対応表)).toBe('');
  });
});
