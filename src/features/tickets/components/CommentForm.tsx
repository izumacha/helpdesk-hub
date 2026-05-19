'use client';

// テキストエリア / ファイル入力の参照と、送信中フラグ
import { useRef, useState, useTransition } from 'react';
// 投稿後のサーバー側キャッシュを再取得させるためのルーター
import { useRouter } from 'next/navigation';
// 添付ファイル件数の上限 (UI ヒント表示用)
import { MAX_ATTACHMENTS_PER_UPLOAD } from '@/domain/attachment';

// 受け取る props (どのチケットへのコメントか)
interface Props {
  ticketId: string;
}

// チケット詳細ページのコメント投稿フォーム
// 本文 + 画像 (任意) を POST /api/tickets/[id]/comments にまとめて送信する。
// Server Action ではなく Route Handler を使う理由: Server Action のリクエストボディは
// 既定 1MB 上限のため、5 枚 × 10MB を許容する設計と相性が悪い (スマホ写真で踏みやすい)。
export function CommentForm({ ticketId }: Props) {
  // 送信中フラグ + トランジション関数
  const [isPending, startTransition] = useTransition();
  // テキストエリアへの参照 (送信後にクリアするため)
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // ファイル入力への参照 (送信後にクリアするため)
  const fileRef = useRef<HTMLInputElement>(null);
  // 送信エラー (Route Handler が返した日本語メッセージ) を保持する
  const [error, setError] = useState<string | null>(null);
  // 投稿成功時にサーバーから新しいコメント / 添付 / 履歴を取り直すためのルーター
  const router = useRouter();

  // 送信ハンドラ
  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    // 既定遷移を抑止して JS 側でハンドリングする
    e.preventDefault();
    // フォームから FormData を組み立てる (本文 + files[])
    const form = e.currentTarget;
    const data = new FormData(form);
    // 本文が空のときは送信せずヒントを出す (Route Handler でも弾くがクライアント側で先に止める)
    const body = ((data.get('body') ?? '') as string).trim();
    if (!body) return;

    // 直前のエラーをクリアしておく
    setError(null);
    // 非ブロッキング送信
    startTransition(async () => {
      // multipart/form-data を Route Handler へ POST する
      // Content-Type は手動指定せず、ブラウザに boundary を自動付与させる
      const res = await fetch(`/api/tickets/${ticketId}/comments`, {
        method: 'POST',
        body: data,
      });

      if (res.ok) {
        // 成功後にテキストエリアとファイル入力をクリアする
        if (textareaRef.current) textareaRef.current.value = '';
        if (fileRef.current) fileRef.current.value = '';
        // サーバーキャッシュを refresh して新しいコメントを画面に反映する
        router.refresh();
        return;
      }

      // 失敗時: Route Handler の error / issues[0].message を読み取って画面に出す
      try {
        const err = (await res.json()) as { error?: string; issues?: Array<{ message?: string }> };
        const issueMessage = Array.isArray(err.issues) ? err.issues[0]?.message : null;
        setError(issueMessage ?? err.error ?? '送信に失敗しました');
      } catch {
        // JSON でないレスポンス (502 等) はステータスをそのまま伝える
        setError(`送信に失敗しました (HTTP ${res.status})`);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      {/* コメント本文 (最大 5000 文字) */}
      <textarea
        ref={textareaRef}
        name="body"
        rows={3}
        required
        maxLength={5000}
        placeholder="コメントを入力してください"
        className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
      />
      {/* 添付ファイル入力 (画像のみ、複数可、スマホはカメラ起動) */}
      <div>
        <label
          htmlFor={`comment-files-${ticketId}`}
          className="block text-xs font-medium text-gray-600"
        >
          写真を添付 (任意、最大 {MAX_ATTACHMENTS_PER_UPLOAD} 枚)
        </label>
        <input
          ref={fileRef}
          id={`comment-files-${ticketId}`}
          type="file"
          name="files"
          accept="image/*"
          // capture="environment" は対応ブラウザ (主にスマホ) で背面カメラを直接起動する
          capture="environment"
          multiple
          className="mt-1 block w-full text-xs text-gray-700 file:mr-3 file:rounded-md file:border-0 file:bg-blue-50 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-blue-700 hover:file:bg-blue-100"
        />
      </div>
      {/* Route Handler エラー表示 */}
      {error && (
        <p role="alert" className="text-xs text-rose-600">
          {error}
        </p>
      )}
      {/* 送信ボタン (送信中は無効化 + 文言切替) */}
      <button
        type="submit"
        disabled={isPending}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {isPending ? '送信中...' : 'コメントを投稿'}
      </button>
    </form>
  );
}
