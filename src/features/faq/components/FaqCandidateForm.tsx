'use client';

// FAQ 候補を作成するサーバーアクション
import { createFaqCandidate } from '@/features/faq/actions/faq-actions';
// テナントモード型 (lite | pro) とラベル一元管理の定数
import type { TenantMode } from '@/domain/types';
import { FAQ_TERM_LABELS } from '@/lib/constants';
// 質問/回答フォームの共通実装 (FaqEditForm と共有。§6 DRY)
import { FaqInlineForm } from '@/features/faq/components/FaqInlineForm';

// このフォームが受け取る props (チケット ID・既定で質問欄に入れるタイトル・テナント mode)
interface Props {
  ticketId: string;
  ticketTitle: string;
  mode: TenantMode;
}

// チケット詳細ページから FAQ 候補を登録するインライン展開フォーム
export function FaqCandidateForm({ ticketId, ticketTitle, mode }: Props) {
  // この機能の呼称 (Lite: よくある質問 / Pro: FAQ候補)
  const termLabel = FAQ_TERM_LABELS[mode];

  return (
    <FaqInlineForm
      toggleLabel={`${termLabel}に登録`}
      toggleClassName="mt-2 rounded-md border border-blue-500 px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50"
      fieldIdPrefix={`faq-create-${ticketId}`}
      defaultQuestion={ticketTitle}
      defaultAnswer=""
      answerPlaceholder="解決方法を入力してください"
      submitLabel="登録"
      // チケットを元に FAQ 候補を新規作成する
      onSubmit={(question, answer) => createFaqCandidate(ticketId, question, answer)}
    />
  );
}
