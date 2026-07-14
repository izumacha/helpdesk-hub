'use client';

// React フック (refs/トランジション/ローカル状態)
import { useRef, useState, useTransition } from 'react';

// FaqCandidateForm (新規登録) と FaqEditForm (その場編集) は「折りたたみ/展開トグル +
// 質問・回答 2 つのテキストエリア + 保存/キャンセル」という同型の UI を持つため、
// 見た目・送信先だけが異なるこの共通部分を切り出した (§6 DRY: 2 箇所目の重複を共通化)。
interface Props {
  // 折りたたみ状態のボタン文言 (例: 「FAQ候補に登録」「編集」)
  toggleLabel: string;
  // 折りたたみ状態のボタンの見た目 (呼び出し元ごとにデザインが異なるため丸ごと渡す)
  toggleClassName: string;
  // トグルボタンのアクセシブルネーム (省略時は toggleLabel をそのまま使う。
  // §7 a11y: 一覧内に同名ボタンが並ぶ場合、対象を区別できる文言を渡す)
  toggleAriaLabel?: string;
  // トグルボタンを一時的に無効化するか (省略時 false。呼び出し元がサーバーの最新値への
  // 同期中であることを示したい場合に使う。例: FaqEditForm が保存成功後の router.refresh()
  // 完了を待つ間、古い defaultQuestion/defaultAnswer で再展開されるのを防ぐ)
  toggleDisabled?: boolean;
  // ラベルと入力欄を紐付ける id の接頭辞 (呼び出し元ごとに一意にすること)
  fieldIdPrefix: string;
  // 質問欄の初期値
  defaultQuestion: string;
  // 回答欄の初期値
  defaultAnswer: string;
  // 回答欄のプレースホルダー (省略可)
  answerPlaceholder?: string;
  // 送信ボタンの文言 (例: 「登録」「保存」。送信中は自動で「〜中...」を付けて表示する)
  submitLabel: string;
  // 送信処理本体 (呼び出し元の Server Action を呼ぶ)
  onSubmit: (question: string, answer: string) => Promise<void>;
  // 送信成功後、フォームを閉じるのに加えて呼び出し元が行いたい後処理 (省略可)
  onSuccess?: () => void;
}

// FAQ の質問/回答を入力する共通のインライン展開フォーム
export function FaqInlineForm({
  toggleLabel,
  toggleClassName,
  toggleAriaLabel,
  toggleDisabled,
  fieldIdPrefix,
  defaultQuestion,
  defaultAnswer,
  answerPlaceholder,
  submitLabel,
  onSubmit,
  onSuccess,
}: Props) {
  // 展開状態 (true で入力欄を表示、false ではボタンのみ)
  const [open, setOpen] = useState(false);
  // 送信中フラグ + トランジション関数
  const [isPending, startTransition] = useTransition();
  // サーバーアクションから返ったエラーを表示する
  const [error, setError] = useState<string | null>(null);
  // 質問/回答テキストエリアへの参照
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const answerRef = useRef<HTMLTextAreaElement>(null);
  // ラベルと入力欄を id で紐付ける (§7 a11y: 呼び出し元ごとに固有の接頭辞を使うため衝突しない)
  const questionFieldId = `${fieldIdPrefix}-question`;
  const answerFieldId = `${fieldIdPrefix}-answer`;

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
        // 呼び出し元から渡された送信処理を実行
        await onSubmit(q, a);
        // 成功時はフォームを閉じる
        setOpen(false);
        // 呼び出し元固有の後処理があれば実行 (例: router.refresh())
        onSuccess?.();
      } catch (err) {
        // 失敗時はエラーメッセージを画面表示
        setError(err instanceof Error ? err.message : 'エラーが発生しました');
      }
    });
  }

  // 折りたたみ状態 (open=false) のときはトグルボタンのみを描画
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label={toggleAriaLabel}
        // 呼び出し元がサーバーの最新値への同期中は再展開を止める (古い初期値での
        // remount を防ぐ。§9 fail-safe: 見た目のクリックできなさより、気付かない
        // 内容巻き戻りの方が実害が大きいため無効化を優先する)
        disabled={toggleDisabled}
        className={`${toggleClassName} disabled:pointer-events-none disabled:opacity-50`}
      >
        {toggleLabel}
      </button>
    );
  }

  return (
    // 展開後のフォーム (質問欄/回答欄/ボタン群)
    <form onSubmit={handleSubmit} className="mt-2 space-y-2">
      <div>
        <label htmlFor={questionFieldId} className="block text-xs font-medium text-gray-600">
          質問
        </label>
        {/* 質問欄 */}
        <textarea
          id={questionFieldId}
          ref={questionRef}
          rows={2}
          required
          maxLength={2000}
          defaultValue={defaultQuestion}
          className="block w-full rounded-md border border-gray-300 px-2 py-1.5 text-xs focus:border-blue-500 focus:outline-none"
        />
      </div>
      <div>
        <label htmlFor={answerFieldId} className="block text-xs font-medium text-gray-600">
          回答
        </label>
        {/* 回答欄 */}
        <textarea
          id={answerFieldId}
          ref={answerRef}
          rows={3}
          required
          maxLength={2000}
          defaultValue={defaultAnswer}
          placeholder={answerPlaceholder}
          className="block w-full rounded-md border border-gray-300 px-2 py-1.5 text-xs focus:border-blue-500 focus:outline-none"
        />
      </div>
      {/* エラー表示 (ある場合のみ) */}
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        {/* 送信ボタン (送信中は無効化) */}
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {isPending ? `${submitLabel}中...` : submitLabel}
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
