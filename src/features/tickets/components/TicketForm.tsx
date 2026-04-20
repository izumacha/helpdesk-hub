'use client';

// ローカル状態 (サーバーエラー保持) 用
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

// プルダウン項目用の最小型 (id と name)
type Category = { id: string; name: string };

// 受け取る props (カテゴリ候補一覧)
interface Props {
  categories: Category[];
}

// 新規チケット作成フォーム (POST /api/tickets を呼ぶ)
export function TicketForm({ categories }: Props) {
  // 登録成功後の遷移用ルーター
  const router = useRouter();
  // サーバー側エラー (フォーム検証エラーとは別) の保持
  const [serverError, setServerError] = useState<string | null>(null);
  // react-hook-form の各種ヘルパー
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CreateTicketFormValues>({
    // Zod でフォームの値を検証
    resolver: zodResolver(createTicketSchema),
    // 優先度の初期値は Medium
    defaultValues: { priority: 'Medium' as const },
  });

  // 送信時の処理 (API ルートへ POST → 成功で詳細ページへ遷移)
  async function onSubmit(data: CreateTicketFormValues) {
    // サーバーエラー表示をクリア
    setServerError(null);
    // POST /api/tickets で作成
    const res = await fetch('/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    // 失敗時はエラー文言を表示して中断
    if (!res.ok) {
      const err = await res.json();
      setServerError(err.error ?? '登録に失敗しました');
      return;
    }

    // 成功時: 作成された行を読み取り、詳細ページへ遷移
    const ticket = await res.json();
    router.push(`/tickets/${ticket.id}`);
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      {/* タイトル */}
      <div>
        <label className="block text-sm font-medium text-gray-700">
          タイトル <span className="text-red-500">*</span>
        </label>
        <input
          {...register('title')}
          type="text"
          maxLength={200}
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          placeholder="件名を入力してください"
        />
        {/* 検証エラーメッセージ */}
        {errors.title && <p className="mt-1 text-xs text-red-600">{errors.title.message}</p>}
      </div>

      {/* 内容 */}
      <div>
        <label className="block text-sm font-medium text-gray-700">
          内容 <span className="text-red-500">*</span>
        </label>
        <textarea
          {...register('body')}
          rows={6}
          maxLength={10000}
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          placeholder="問い合わせ内容を入力してください"
        />
        {errors.body && <p className="mt-1 text-xs text-red-600">{errors.body.message}</p>}
      </div>

      {/* カテゴリ (選択任意) */}
      <div>
        <label className="block text-sm font-medium text-gray-700">カテゴリ</label>
        <select
          {...register('categoryId')}
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        >
          <option value="">選択しない</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {/* 優先度 */}
      <div>
        <label className="block text-sm font-medium text-gray-700">優先度</label>
        <select
          {...register('priority')}
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        >
          {/* PRIORITY_LABELS の [値, 表示名] を順に並べる */}
          {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {/* サーバー由来エラー (API レスポンス) */}
      {serverError && <p className="text-sm text-red-600">{serverError}</p>}

      {/* アクション (登録/キャンセル) */}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={isSubmitting}
          className="rounded-md bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {isSubmitting ? '登録中...' : '登録する'}
        </button>
        <button
          type="button"
          onClick={() => router.back()}
          className="rounded-md border border-gray-300 px-5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          キャンセル
        </button>
      </div>
    </form>
  );
}
