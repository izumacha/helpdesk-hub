'use client';

// 更新後にサーバー側キャッシュを再取得させるためのルーター
import { useRouter } from 'next/navigation';
// FAQ 候補の本文を編集するサーバーアクション
import { updateFaqContent } from '@/features/faq/actions/faq-actions';
// 質問/回答フォームの共通実装 (FaqCandidateForm と共有。§6 DRY)
import { FaqInlineForm } from '@/features/faq/components/FaqInlineForm';

// このフォームが受け取る props (対象 FAQ の ID と現在の質問/回答)
interface Props {
  faqId: string;
  question: string;
  answer: string;
}

// フォローアップ (2026-07-14 #6): 公開後に誤りへ気付いても訂正する手段が無かったギャップ対応。
// エージェント向け管理ビューで、既存 FAQ (ステータス不問) の質問/回答をその場で編集できる
export function FaqEditForm({ faqId, question, answer }: Props) {
  // 更新成功後に FAQ 一覧を再取得させるためのルーター
  const router = useRouter();

  return (
    <FaqInlineForm
      toggleLabel="編集"
      toggleClassName="mt-2 text-xs font-medium text-teal-700 hover:underline"
      // 一覧内に同じ「編集」ボタンが並ぶため、対象の質問文でスクリーンリーダー向けに区別する (§7 a11y)
      toggleAriaLabel={`${question} を編集`}
      fieldIdPrefix={`faq-edit-${faqId}`}
      defaultQuestion={question}
      defaultAnswer={answer}
      submitLabel="保存"
      // 質問/回答の本文を更新する
      onSubmit={(q, a) => updateFaqContent(faqId, q, a)}
      // 更新後はサーバーから最新の質問/回答を取り直す
      onSuccess={() => router.refresh()}
    />
  );
}
