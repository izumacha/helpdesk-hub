'use client';

// テキストエリア / ファイル入力の参照と、送信中フラグ
import { useRef, useState, useTransition } from 'react';
// 投稿後のサーバー側キャッシュを再取得させるためのルーター
import { useRouter } from 'next/navigation';
// MAX_ATTACHMENTS_PER_UPLOAD は UI ヒント表示用、残り 2 つは送信前の添付チェックと
// 未選択 file input の番兵除去 (いずれもサーバー検証と規則・文言を共有する)
import {
  MAX_ATTACHMENTS_PER_UPLOAD,
  findAttachmentPreflightError,
  selectAttachmentFiles,
} from '@/domain/attachment';
// 「送信そのものが成立しなかった」ときの共通文言 (新規起票フォームと共有)
import { COMMENT_RESULT_UNKNOWN_MESSAGE, NETWORK_ERROR_MESSAGE } from '@/lib/constants';
// エラー応答から画面用のメッセージを取り出す共通ヘルパー (新規起票フォームと共有)
import { readApiErrorMessage } from '@/lib/api-error-message';

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

    // 送信前に、ブラウザ側で判定できる添付の違反 (件数・空・1 件あたりのサイズ) を先に弾く。
    // 枠 (51MB) を超える送信はサーバーが本文を読まずに 413 を返すため、そのまま送ると接続断で
    // fetch が reject し「通信状態をご確認ください」という的外れな案内しか出せない。
    // 検証の本体はサーバー側 (validateUploadedFiles) のままで、これは体験のための先回り。
    // 未選択の file input が足す番兵 (name/size とも空の File) は selectAttachmentFiles が落とす —
    // ここを instanceof File だけで済ませると、添付なしのコメントが毎回
    // 「空のファイルは添付できません」で止まってしまう
    const selectedFiles = selectAttachmentFiles(data.getAll('files'));
    const attachmentError = findAttachmentPreflightError(selectedFiles);
    if (attachmentError) {
      // 具体的な理由 (「1 ファイルあたり 10.0MB までです」等) をそのまま画面に出す
      setError(attachmentError);
      return;
    }

    // 非ブロッキング送信
    startTransition(async () => {
      // multipart/form-data を Route Handler へ POST する
      // Content-Type は手動指定せず、ブラウザに boundary を自動付与させる。
      // 送信そのものが成立しないこと (オフライン・接続断・サーバーが本文を読まずに応答を返した等) が
      // あるため try/catch で囲む。catch が無いと例外がそのまま浮いて画面に何も表示されない
      let res: Response;
      try {
        res = await fetch(`/api/tickets/${ticketId}/comments`, {
          method: 'POST',
          body: data,
        });
      } catch (fetchErr) {
        // 何が起きたか (オフライン / 接続断 / 413 由来のリセット) を後から切り分けられるよう、
        // 例外は捨てずにブラウザのコンソールへ文脈付きで残す (§6 エラーを握り潰さない)
        console.error('[CommentForm] コメントの送信に失敗しました', fetchErr);
        // 応答を受け取れていないので、サーバーの文言ではなく共通の通信失敗文言を出す
        setError(NETWORK_ERROR_MESSAGE);
        return;
      }

      if (res.ok) {
        // **2xx というだけで成功扱いにしない。** このルートは成功時に必ず {"ok": true} を返すので、
        // それを確かめてから入力欄を消す。社内プロキシやキャッシュ層が差し込んだ 200 の HTML を
        // 成功と見なすと、実際には投稿されていないのに**利用者が書いた本文を消してしまう**
        let accepted = false;
        try {
          const body = (await res.json()) as { ok?: boolean } | null;
          accepted = body?.ok === true;
        } catch (parseErr) {
          // 解析できなかった理由はコンソールに残す (§6 エラーを握り潰さない)
          console.error('[CommentForm] 成功応答を JSON として解析できませんでした', parseErr);
        }
        // 確認できなければ本文を残したまま、成功とも失敗とも言い切らない文言を出す
        if (!accepted) {
          setError(COMMENT_RESULT_UNKNOWN_MESSAGE);
          return;
        }
        // 成功が確認できたのでテキストエリアとファイル入力をクリアする
        if (textareaRef.current) textareaRef.current.value = '';
        if (fileRef.current) fileRef.current.value = '';
        // サーバーキャッシュを refresh して新しいコメントを画面に反映する
        router.refresh();
        return;
      }

      // 失敗時: Route Handler の error / issues[0].message を読み取って画面に出す。
      // 読み取り手順は新規起票フォームと共通のヘルパーに委ねる (§6 DRY)
      setError(
        await readApiErrorMessage(res, {
          fallbackMessage: '送信に失敗しました',
          logPrefix: '[CommentForm]',
        }),
      );
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
