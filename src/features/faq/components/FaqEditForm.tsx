'use client';

// React フック (refs/トランジション/ローカル状態)
import { useRef, useState, useTransition } from 'react';
// 更新後にサーバー側キャッシュを再取得させるためのルーター
import { useRouter } from 'next/navigation';
// FAQ 候補の本文を編集するサーバーアクション
import { updateFaqContent } from '@/features/faq/actions/faq-actions';

// このフォームが受け取る props (対象 FAQ の ID と現在の質問/回答)
interface Props {
  faqId: string;
  question: string;
  answer: string;
}

// フォローアップ (2026-07-14 #6): 公開後に誤りへ気付いても訂正する手段が無かったギャップ対応。
// エージェント向け管理ビューで、既存 FAQ (ステータス不問) の質問/回答をその場で編集できる
export function FaqEditForm({ faqId, question, answer }: Props) {
  // 展開状態 (true で編集フォームを表示、false では「編集」ボタンのみ)
  const [open, setOpen] = useState(false);
  // 送信中フラグ + トランジション関数
  const [isPending, startTransition] = useTransition();
  // サーバーアクションから返ったエラーを表示する
  const [error, setError] = useState<string | null>(null);
  // 質問/回答テキストエリアへの参照
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const answerRef = useRef<HTMLTextAreaElement>(null);
  // 更新成功後に FAQ 一覧を再取得させるためのルーター
  const router = useRouter();

  // 送信ハンドラ (画面遷移を抑止し、検証 + 非同期送信)
  function handleSubmit(e: React.FormEvent) {
    // 既定のページ遷移を抑止
    e.preventDefault();
    // 入力値を trim して取り出す
    const q = questionRef.current?.value.trim() ?? '';
    const a = answerRef.current?.value.trim() ?? '';
    // 質問/回答どちらかが空なら何もしない
    if (!q || !a) return;

    // 直前のエラー表示をクリア
    setError(null);
    // 非ブロッキングで実行 (UI が固まらない)
    startTransition(async () => {
      try {
        // サーバーアクション呼び出し
        await updateFaqContent(faqId, q, a);
        // 成功時はフォームを閉じ、サーバーから最新の質問/回答を取り直す
        setOpen(false);
        router.refresh();
      } catch (err) {
        // 失敗時はエラーメッセージを画面表示
        setError(err instanceof Error ? err.message : 'エラーが発生しました');
      }
    });
  }

  // 折りたたみ状態 (open=false) のときは「編集」ボタンのみを描画
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-2 text-xs font-medium text-teal-700 hover:underline"
      >
        編集
      </button>
    );
  }

  // ラベルと入力欄を id で紐付けるための一意な ID (§7 a11y: スクリーンリーダーに
  // 対応関係を伝えるため、同一 FAQ でも他の FaqEditForm インスタンスと衝突しないよう faqId を含める)
  const questionFieldId = `faq-edit-question-${faqId}`;
  const answerFieldId = `faq-edit-answer-${faqId}`;

  return (
    // 展開後のフォーム (質問欄/回答欄/ボタン群)
    <form onSubmit={handleSubmit} className="mt-2 space-y-2">
      <div>
        <label htmlFor={questionFieldId} className="block text-xs font-medium text-gray-600">
          質問
        </label>
        {/* 質問欄 (既定値は現在の質問文) */}
        <textarea
          id={questionFieldId}
          ref={questionRef}
          rows={2}
          required
          maxLength={2000}
          defaultValue={question}
          className="block w-full rounded-md border border-gray-300 px-2 py-1.5 text-xs focus:border-blue-500 focus:outline-none"
        />
      </div>
      <div>
        <label htmlFor={answerFieldId} className="block text-xs font-medium text-gray-600">
          回答
        </label>
        {/* 回答欄 (既定値は現在の回答文) */}
        <textarea
          id={answerFieldId}
          ref={answerRef}
          rows={3}
          required
          maxLength={2000}
          defaultValue={answer}
          className="block w-full rounded-md border border-gray-300 px-2 py-1.5 text-xs focus:border-blue-500 focus:outline-none"
        />
      </div>
      {/* エラー表示 (ある場合のみ) */}
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        {/* 保存ボタン (送信中は無効化) */}
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {isPending ? '保存中...' : '保存'}
        </button>
        {/* キャンセル (フォームを閉じる) */}
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
        >
          キャンセル
        </button>
      </div>
    </form>
  );
}
