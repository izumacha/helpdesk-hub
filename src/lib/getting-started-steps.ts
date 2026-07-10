/**
 * ダッシュボードの「はじめかた」チュートリアルステップを組み立てる純粋ヘルパー
 * (Phase 3 オンボーディング / docs/smb-dx-pivot-plan.md §7.1)。
 *
 * §7.1.2 フォローアップ (2026-07-10): メール取り込みを利用できないプラン (Free。トライアル外) では
 * 「設定画面に専用の転送アドレスが表示されます」と案内しても、settings/page.tsx 側の
 * emailInboundAllowed ゲートによって実際にはそのカードが表示されず、admin を行き止まりに
 * 案内してしまっていた。settings/page.tsx と同じ判定をここにも適用し、案内内容とプランの
 * 実態を一致させる。
 */

// チュートリアルセクションに表示する「はじめかた」ステップの基本定義。
// 変更が必要なら以下のオブジェクトを直接編集する (各所に散らさない §6 定数の一元管理)。
// メール転送ステップだけは buildGettingStartedSteps でプランに応じて出し分けるため、
// ここでは step 番号を持たない。
const GETTING_STARTED_STEP_DEFS = {
  inviteStaff: {
    title: 'スタッフを招待する', // ステップのタイトル
    description: '設定画面の「招待リンク発行」からメンバーを招待しましょう。', // 補足説明
    href: '/settings/invite', // 誘導先のリンク (ない場合は null)
  },
  emailForwarding: {
    title: 'メールの転送アドレスを設定する',
    description:
      '設定画面に専用の転送アドレスが表示されます。Gmail や Outlook の自動転送を設定すると、メールが届くたびに自動で問い合わせが作成されます。',
    href: '/settings',
  },
  tryOnPhone: {
    title: 'スマホから試してみる',
    description:
      'このページをスマホのブラウザで開き、ホーム画面に追加すると、アプリのように使えます。',
    href: null,
  },
} as const;

// 「はじめかた」ステップ 1 件分の型 (画面側の props/JSX で使う)
export interface GettingStartedStep {
  step: number; // 表示用のステップ番号 (1 始まり)
  title: string; // ステップのタイトル
  description: string; // 補足説明
  href: string | null; // 誘導先のリンク (ない場合は null)
}

// 「はじめかた」ステップ一覧を組み立てる純粋関数。
// メール転送ステップを省いた場合は残りのステップ番号を詰めて振り直す
// (1, 3 のような歯抜けの番号を画面に出さないため)。
export function buildGettingStartedSteps(emailInboundAllowed: boolean): GettingStartedStep[] {
  // 常に含める基本ステップに、メール取り込みが使えるプランのときだけ転送設定ステップを差し込む
  const steps = [
    GETTING_STARTED_STEP_DEFS.inviteStaff,
    ...(emailInboundAllowed ? [GETTING_STARTED_STEP_DEFS.emailForwarding] : []),
    GETTING_STARTED_STEP_DEFS.tryOnPhone,
  ];
  // 表示用のステップ番号を採番順に振り直して返す
  return steps.map((s, i) => ({ ...s, step: i + 1 }));
}
