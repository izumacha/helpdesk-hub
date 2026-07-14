// FAQ 状態 (FaqStatus) の型を「正準 (Single Source of Truth)」であるドメイン型定義から読み込む
import type { FaqStatus } from '@/domain/types';

// フォローアップ (2026-07-14 #6): 公開済み FAQ を非公開に戻す遷移を追加した際、
// src/features/faq/actions/faq-actions.ts のインライン真偽式と
// src/app/(app)/faq/page.tsx の JSX 条件表示が同じルールを別々に書いており、
// 一方だけ更新すると食い違う恐れがあった。src/domain/ticket-status.ts の
// ALLOWED_TRANSITIONS と同じ「唯一の源」パターンを FAQ にも適用し、両所から
// この表を参照させる (Server Action は許可判定に、UI はボタン表示条件に使う)。
// 以下は「どの状態からどの状態へ変えてよいか」を表す表 (遷移許可リスト)
const ALLOWED_TRANSITIONS: Record<FaqStatus, FaqStatus[]> = {
  Candidate: ['Published', 'Rejected'], // 候補から公開/却下のどちらかを選ぶ (レビュー結果)
  Published: ['Rejected'], // 公開済みは却下 (非公開化) のみ許可。訂正は編集 (updateContent) で対応
  Rejected: [], // 却下からの遷移は対象外 (候補への差し戻しは別スコープ)
};

// 現在状態 from から次状態 to に遷移してよいかを true/false で返す関数
export function isValidFaqTransition(from: FaqStatus, to: FaqStatus): boolean {
  // 許可表を参照し、to が含まれていれば遷移可能
  return ALLOWED_TRANSITIONS[from].includes(to);
}
