'use client';

// ローカル状態 (サーバーエラー / 添付ファイル選択状態) 用
import { useState } from 'react';
// react-hook-form 本体 (フォーム状態管理)
import { useForm } from 'react-hook-form';
// Zod スキーマと react-hook-form を繋ぐリゾルバー
import { zodResolver } from '@hookform/resolvers/zod';
// 登録成功後のページ遷移用
import { useRouter } from 'next/navigation';
// チケット作成入力の Zod スキーマと型
import { createTicketSchema, type CreateTicketFormValues } from '@/lib/validations/ticket';
// 優先度の日本語ラベル
import { PRIORITY_LABELS } from '@/lib/constants';
// テナントモード型 (lite | pro)。Lite では入力項目を 3 つに絞る
import type { TenantMode } from '@/domain/types';
// 添付ファイル件数の上限 (UI ヒント表示用)
import { MAX_ATTACHMENTS_PER_UPLOAD } from '@/domain/attachment';

// プルダウン項目用の最小型 (id と name)
type Category = { id: string; name: string };

// 受け取る props (カテゴリ候補一覧 + テナント mode)
interface Props {
  categories: Category[];
  // テナントの動作モード。'lite' (既定) では件名/内容/期限日のみ表示する
  mode: TenantMode;
}

// 入力欄に共通で当てるベースクラス (フォーカス時のティールリングを統一)
const fieldBaseClass =
  'block w-full rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-base text-slate-900 placeholder:text-slate-400 transition focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/30 sm:text-sm';
// 入力エラー時に追加で当てる枠色
const fieldErrorClass = 'border-rose-400 focus:border-rose-500 focus:ring-rose-500/30';

// 「必須」を示す小さな pill (健診の問診票風に柔らかく)
function RequiredPill() {
  return (
    <span className="ml-1 rounded bg-teal-50 px-1.5 py-0.5 text-[10px] font-semibold text-teal-700">
      必須
    </span>
  );
}

// 新規チケット作成フォーム (POST /api/tickets を呼ぶ)
export function TicketForm({ categories, mode }: Props) {
  // 登録成功後の遷移用ルーター
  const router = useRouter();
  // サーバー側エラー (フォーム検証エラーとは別) の保持
  const [serverError, setServerError] = useState<string | null>(null);
  // 添付ファイル選択状態 (onChange でセット、送信後にクリア)
  // ref を読まずに state 経由で渡すことで「render 中の ref 参照」警告を回避する
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  // Lite モードフラグ (件名/内容/期限日のみの簡易フォームに切替)
  const isLite = mode === 'lite';
  // react-hook-form の各種ヘルパー
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CreateTicketFormValues>({
    // Zod でフォームの値を検証
    resolver: zodResolver(createTicketSchema),
    // 優先度の初期値は Medium (Lite では UI から選ばせず常に Medium のまま送る)
    defaultValues: { priority: 'Medium' as const },
  });

  // 送信時の処理 (API ルートへ POST → 成功で詳細ページへ遷移)
  // 添付ファイルの有無で送信方式を切替: 添付ありなら multipart/form-data、無しは従来どおり JSON
  async function onSubmit(data: CreateTicketFormValues) {
    // サーバーエラー表示をクリア
    setServerError(null);

    // 選択中のファイル (state から取得)
    const hasFiles = selectedFiles.length > 0;

    // 送信用のリクエスト本体を選択: hasFiles なら FormData、それ以外は JSON
    let res: Response;
    if (hasFiles) {
      // multipart/form-data を組み立てる
      const fd = new FormData();
      // フォームの各フィールドを文字列として詰める (Zod は string を受け取る)
      fd.set('title', data.title);
      fd.set('body', data.body);
      fd.set('priority', data.priority);
      // optional フィールドは値があるときだけセットする
      if (data.categoryId) fd.set('categoryId', data.categoryId);
      if (data.dueDate) fd.set('dueDate', data.dueDate);
      // ファイルは files キーに同名で複数 append する
      for (const f of selectedFiles) fd.append('files', f, f.name);
      // Content-Type は手動で指定せず、ブラウザに自動で boundary を組み立てさせる
      res = await fetch('/api/tickets', { method: 'POST', body: fd });
    } else {
      // 添付なしの単純パス (従来どおり JSON で送る)
      res = await fetch('/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    }

    // 失敗時はエラー文言を表示して中断
    if (!res.ok) {
      const err = await res.json();
      // 添付検証 (422 + issues に path:['files'] が入る) のメッセージも拾える
      const issueMessage = Array.isArray(err.issues) ? err.issues[0]?.message : null;
      setServerError(issueMessage ?? err.error ?? '登録に失敗しました');
      return;
    }

    // 成功時: 作成された行を読み取り、詳細ページへ遷移
    const ticket = await res.json();
    router.push(`/tickets/${ticket.id}`);
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {/* タイトル */}
      <div>
        <label
          htmlFor="title"
          className="mb-1.5 flex items-center text-sm font-medium text-slate-700"
        >
          タイトル
          <RequiredPill />
        </label>
        <input
          id="title"
          {...register('title')}
          type="text"
          maxLength={200}
          aria-invalid={errors.title ? 'true' : 'false'}
          className={`${fieldBaseClass} ${errors.title ? fieldErrorClass : ''}`}
          placeholder="件名を入力してください"
        />
        {/* 検証エラーメッセージ */}
        {errors.title && <p className="mt-1.5 text-xs text-rose-600">{errors.title.message}</p>}
      </div>

      {/* 内容 */}
      <div>
        <label
          htmlFor="body"
          className="mb-1.5 flex items-center text-sm font-medium text-slate-700"
        >
          内容
          <RequiredPill />
        </label>
        <textarea
          id="body"
          {...register('body')}
          rows={6}
          maxLength={10000}
          aria-invalid={errors.body ? 'true' : 'false'}
          className={`${fieldBaseClass} ${errors.body ? fieldErrorClass : ''}`}
          placeholder="問い合わせ内容を入力してください"
        />
        {errors.body && <p className="mt-1.5 text-xs text-rose-600">{errors.body.message}</p>}
      </div>

      {/* 添付ファイル (任意。スマホで撮った写真を最大 5 枚まで添付できる) */}
      <div>
        <label htmlFor="files" className="mb-1.5 block text-sm font-medium text-slate-700">
          {/* Lite ではより平易な表記、Pro でも同じラベルで十分なので統一する */}
          写真を添付
        </label>
        <input
          id="files"
          name="files"
          type="file"
          // 画像のみ受け付ける。MIME 検証は API 側でも行う (UI のフィルタは「ヒント」扱い)
          accept="image/*"
          // capture="environment" は対応ブラウザでスマホの背面カメラを直接起動する
          capture="environment"
          multiple
          // 選択内容を state に保持する (送信時に state から FormData を組み立てる)
          onChange={(e) => setSelectedFiles(Array.from(e.target.files ?? []))}
          className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-teal-50 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-teal-700 hover:file:bg-teal-100"
        />
        <p className="mt-1 text-xs text-slate-400">
          {/* 件数とサイズの目安を 1 行で案内 (詳細は API のエラーメッセージに委ねる) */}
          画像を最大 {MAX_ATTACHMENTS_PER_UPLOAD} 枚 / 1 枚 10MB まで添付できます (任意)
        </p>
      </div>

      {/* 期限日 (Lite モードのみ表示。Pro はカテゴリ/優先度で自動 SLA を使うため非表示) */}
      {isLite && (
        <div>
          <label htmlFor="dueDate" className="mb-1.5 block text-sm font-medium text-slate-700">
            いつまでに
          </label>
          <input
            id="dueDate"
            // YYYY-MM-DD 形式で値が送られる (Zod 側で同じ形式を期待)
            type="date"
            {...register('dueDate')}
            aria-invalid={errors.dueDate ? 'true' : 'false'}
            className={`${fieldBaseClass} ${errors.dueDate ? fieldErrorClass : ''}`}
          />
          {/* 期限日の検証エラー (形式不正・実在しない日付など) */}
          {errors.dueDate && (
            <p className="mt-1.5 text-xs text-rose-600">{errors.dueDate.message}</p>
          )}
          {/* 補足: 任意項目であることを明示 (Lite では SLA 自動計算より明示入力を優先) */}
          <p className="mt-1 text-xs text-slate-400">
            未入力の場合は自動で期限を設定します
          </p>
        </div>
      )}

      {/* カテゴリ (Pro モードのみ。Lite では非表示) */}
      {!isLite && (
        <div>
          <label htmlFor="categoryId" className="mb-1.5 block text-sm font-medium text-slate-700">
            カテゴリ
          </label>
          <select id="categoryId" {...register('categoryId')} className={fieldBaseClass}>
            <option value="">選択しない</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* 優先度 (Pro モードのみ。Lite では Medium 固定送信のため hidden で保持) */}
      {!isLite ? (
        <div>
          <label htmlFor="priority" className="mb-1.5 block text-sm font-medium text-slate-700">
            優先度
          </label>
          <select id="priority" {...register('priority')} className={fieldBaseClass}>
            {/* PRIORITY_LABELS の [値, 表示名] を順に並べる */}
            {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        // Lite モードでも Zod スキーマが priority を必須とするため hidden で初期値を保持
        <input type="hidden" {...register('priority')} value="Medium" />
      )}

      {/* サーバー由来エラー (API レスポンス) ─ 柔らかなロゼ枠 */}
      {serverError && (
        <p
          role="alert"
          className="rounded-lg bg-rose-50 px-3 py-2.5 text-sm text-rose-700 ring-1 ring-rose-200"
        >
          {serverError}
        </p>
      )}

      {/* アクション (キャンセル + 登録) ─ 右寄せで主要 CTA を強調 */}
      <div className="flex items-center justify-end gap-3 border-t border-slate-100 pt-5">
        <button
          type="button"
          onClick={() => router.back()}
          className="rounded-lg px-5 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
        >
          キャンセル
        </button>
        <button
          type="submit"
          disabled={isSubmitting}
          aria-busy={isSubmitting}
          className="rounded-lg bg-teal-700 px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? '登録中...' : '登録する'}
        </button>
      </div>
    </form>
  );
}
