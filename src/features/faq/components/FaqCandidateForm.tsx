'use client';

// React フック (refs/トランジション/ローカル状態)
import { useRef, useTransition, useState } from 'react';
// FAQ 候補を作成するサーバーアクション
import { createFaqCandidate } from '@/features/faq/actions/faq-actions';

// このフォームが受け取る props (チケット ID と既定で質問欄に入れるタイトル)
interface Props {
  ticketId: string;
  ticketTitle: string;
}

// チケット詳細ページから FAQ 候補を登録するインライン展開フォーム
export function FaqCandidateForm({ ticketId, ticketTitle }: Props) {
  // 展開状態 (true で入力欄を表示、false ではボタンのみ)
  const [open, setOpen] = useState(false);
  // 送信中フラグ + トランジション関数
  const [isPending, startTransition] = useTransition();
  // サーバーアクションから返ったエラーを表示する
  const [error, setError] = useState<string | null>(null);
  // 質問/回答テキストエリアへの参照
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const answerRef = useRef<HTMLTextAreaElement>(null);

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
        await createFaqCandidate(ticketId, q, a);
        // 成功時はフォームを閉じる
        setOpen(false);
      } catch (err) {
        // 失敗時はエラーメッセージを画面表示
        setError(err instanceof Error ? err.message : 'エラーが発生しました');
      }
    });
  }

  // 折りたたみ状態 (open=false) のときは「FAQ 候補に登録」ボタンのみを描画
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-2 rounded-md border border-blue-500 px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50"
      >
        FAQ候補に登録
      </button>
    );
  }

  return (
    // 展開後のフォーム (質問欄/回答欄/ボタン群)
    <form onSubmit={handleSubmit} className="mt-2 space-y-2">
      <div>
        <label className="block text-xs font-medium text-gray-600">質問</label>
        {/* 質問欄 (既定値はチケット件名) */}
        <textarea
          ref={questionRef}
          rows={2}
          required
          maxLength={2000}
          defaultValue={ticketTitle}
          className="block w-full rounded-md border border-gray-300 px-2 py-1.5 text-xs focus:border-blue-500 focus:outline-none"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600">回答</label>
        {/* 回答欄 */}
        <textarea
          ref={answerRef}
          rows={3}
          required
          maxLength={2000}
          placeholder="解決方法を入力してください"
          className="block w-full rounded-md border border-gray-300 px-2 py-1.5 text-xs focus:border-blue-500 focus:outline-none"
        />
      </div>
      {/* エラー表示 (ある場合のみ) */}
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        {/* 登録ボタン (送信中は無効化) */}
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {isPending ? '登録中...' : '登録'}
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
