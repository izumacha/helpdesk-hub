'use client';

// ローカル状態 (サーバーエラー / 添付ファイル選択状態 / モバイルステップ) 用
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
// モバイルではステップ式 UI（ステップ 1: タイトル/内容 → ステップ 2: 写真/オプション）、
// デスクトップ (sm 以上) では全フィールドを 1 ページに表示する。
export function TicketForm({ categories, mode }: Props) {
  // 登録成功後の遷移用ルーター
  const router = useRouter();
  // サーバー側エラー (フォーム検証エラーとは別) の保持
  const [serverError, setServerError] = useState<string | null>(null);
  // 添付ファイル選択状態 (onChange でセット、送信後にクリア)
  // ref を読まずに state 経由で渡すことで「render 中の ref 参照」警告を回避する
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  // モバイル用ステップ (1 = タイトル/内容、2 = 写真/オプション)。
  // デスクトップでは step 値に関わらず全フィールドを表示するため、CSS (sm:block) で上書きする。
  const [step, setStep] = useState<1 | 2>(1);
  // Lite モードフラグ (件名/内容/期限日のみの簡易フォームに切替)
  const isLite = mode === 'lite';
  // react-hook-form の各種ヘルパー (trigger でステップ 1 の部分検証を行う)
  const {
    register,
    handleSubmit,
    trigger,
    formState: { errors, isSubmitting },
  } = useForm<CreateTicketFormValues>({
    // Zod でフォームの値を検証
    resolver: zodResolver(createTicketSchema),
    // 優先度の初期値は Medium (Lite では UI から選ばせず常に Medium のまま送る)
    defaultValues: { priority: 'Medium' as const },
  });

  // 「次へ」ボタン: ステップ 1 の必須フィールド (タイトル・内容) を検証してからステップ 2 へ進む
  async function handleNext() {
    // タイトルと内容だけを部分的に検証する (ステップ 2 フィールドはスキップ)
    const valid = await trigger(['title', 'body']);
    // 検証が通った場合のみステップを進める
    if (valid) setStep(2);
  }

  // モバイルのステップ 2 でフォームを送信したとき、ステップ 1 のフィールド (title/body) に
  // バリデーションエラーがある場合はステップ 1 に戻ってエラーを表示させる。
  // (ステップ 1 div が CSS hidden になっているとエラー <p> が不可視になるため)
  function handleInvalid(fieldErrors: typeof errors) {
    // title または body にエラーがあればステップ 1 へ戻る (エラー表示を visible にする)
    if (fieldErrors.title || fieldErrors.body) {
      setStep(1);
    }
  }

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
    <form onSubmit={handleSubmit(onSubmit, handleInvalid)} className="space-y-6">
      {/* ステップインジケーター (モバイルのみ表示。デスクトップは全フィールドを 1 画面で見せる) */}
      <div className="flex items-center justify-center gap-2 sm:hidden" aria-hidden="true">
        {/* ステップ 1 のドット (現在ステップなら teal、済んだら slate) */}
        <div
          className={`h-1.5 rounded-full transition-all ${step === 1 ? 'w-8 bg-teal-600' : 'w-3 bg-slate-300'}`}
        />
        {/* ステップ 2 のドット (まだなら slate、現在なら teal) */}
        <div
          className={`h-1.5 rounded-full transition-all ${step === 2 ? 'w-8 bg-teal-600' : 'w-3 bg-slate-300'}`}
        />
      </div>

      {/* ===== ステップ 1: タイトル + 内容 ===== */}
      {/* モバイル: step === 1 のときだけ表示 (hidden で隠し、sm:block で上書き)。デスクトップ: 常時表示 */}
      <div className={step === 1 ? 'space-y-6' : 'hidden space-y-6 sm:block'}>
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
      </div>

      {/* ===== ステップ 2: 写真 + 任意オプション ===== */}
      {/* モバイル: step === 2 のときだけ表示。デスクトップ: 常時表示 */}
      <div className={step === 2 ? 'space-y-6' : 'hidden space-y-6 sm:block'}>
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
            <p className="mt-1 text-xs text-slate-400">未入力の場合は自動で期限を設定します</p>
          </div>
        )}

        {/* カテゴリ (Pro モードのみ。Lite では非表示) */}
        {!isLite && (
          <div>
            <label
              htmlFor="categoryId"
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
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

        {/* 優先度 (Pro モードのみ表示。Lite モードでは hidden で Medium を保持する) */}
        {!isLite && (
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
        )}
      </div>

      {/* Lite モードでは優先度を Medium に固定し、Zod 必須バリデーションを満たすために hidden で保持する */}
      {isLite && <input type="hidden" {...register('priority')} value="Medium" />}

      {/* サーバー由来エラー (API レスポンス) ─ 柔らかなロゼ枠 */}
      {serverError && (
        <p
          role="alert"
          className="rounded-lg bg-rose-50 px-3 py-2.5 text-sm text-rose-700 ring-1 ring-rose-200"
        >
          {serverError}
        </p>
      )}

      {/* アクションボタン行 */}
      {/* デスクトップ: キャンセル + 登録する (右寄せ) */}
      {/* モバイル ステップ 1: キャンセル + 次へ → */}
      {/* モバイル ステップ 2: ← 戻る + 登録する */}
      <div className="flex items-center justify-between border-t border-slate-100 pt-5 sm:justify-end sm:gap-3">
        {/* キャンセル (デスクトップ常時 + モバイルステップ 1 のみ) */}
        <button
          type="button"
          onClick={() => router.back()}
          className={`rounded-lg px-5 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 ${step === 2 ? 'hidden sm:block' : ''}`}
        >
          キャンセル
        </button>

        {/* 戻る (モバイルのステップ 2 のみ表示。デスクトップでは非表示) */}
        {step === 2 && (
          <button
            type="button"
            onClick={() => setStep(1)}
            className="rounded-lg px-5 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 sm:hidden"
          >
            ← 戻る
          </button>
        )}

        {/* 右側: 次へ or 登録する */}
        <div className="flex items-center gap-3">
          {/* 次へ → (モバイルのステップ 1 のみ。デスクトップでは非表示) */}
          {step === 1 && (
            <button
              type="button"
              onClick={handleNext}
              className="rounded-lg bg-teal-700 px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-800 sm:hidden"
            >
              次へ →
            </button>
          )}

          {/* 登録する (デスクトップ常時 + モバイルのステップ 2 のみ) */}
          <button
            type="submit"
            disabled={isSubmitting}
            aria-busy={isSubmitting}
            className={`rounded-lg bg-teal-700 px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-60 ${step === 1 ? 'hidden sm:block' : ''}`}
          >
            {isSubmitting ? '登録中...' : '登録する'}
          </button>
        </div>
      </div>
    </form>
  );
}
