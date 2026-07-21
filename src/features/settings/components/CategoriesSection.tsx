'use client';

// フォローアップ (2026-07-21): テナント内のカテゴリ一覧を管理する Client Component。
// 管理者がカテゴリの追加・編集・削除を行うための UI を提供する。
// LocationsSection.tsx と同じ設計 (§6 DRY: 一覧+追加フォーム+インライン編集/削除の型を踏襲)。
// カテゴリは Pro モード専用の概念 (TicketForm.tsx の isLite 分岐参照) のため、
// 設定ページ側で mode === 'pro' のときのみこのセクションを描画する。

// React の状態管理・副作用フック
import { useState, useTransition } from 'react';
// カテゴリ操作の Server Actions
import { createCategory } from '@/features/settings/actions/create-category';
import { updateCategory } from '@/features/settings/actions/update-category';
import { deleteCategory } from '@/features/settings/actions/delete-category';
// カテゴリ概要型 (id / name のみ)
import type { CategorySummary } from '@/data/ports/category-repository';

// 受け取る props (初期のカテゴリ一覧)
interface Props {
  // 現在のテナントに登録されているカテゴリ一覧 (名前昇順)
  categories: CategorySummary[];
}

// 入力欄に共通で当てるベースクラス (LocationsSection.tsx と同一)
const fieldClass =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500';

// カテゴリ管理セクション (一覧表示 + 追加フォーム + 編集/削除)
export function CategoriesSection({ categories: initialCategories }: Props) {
  // ローカルでカテゴリ一覧を保持して追加/削除を即時反映する
  const [categories, setCategories] = useState<CategorySummary[]>(initialCategories);
  // 新規追加フォームの表示フラグ
  const [showAddForm, setShowAddForm] = useState(false);
  // 編集中のカテゴリ ID (null なら非編集モード)
  const [editingId, setEditingId] = useState<string | null>(null);
  // エラーメッセージ (操作失敗時に表示)
  const [error, setError] = useState<string | null>(null);
  // 成功メッセージ (操作成功時に表示)
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  // 送信中フラグ (二重送信防止)
  const [isPending, startTransition] = useTransition();

  // メッセージをクリアするヘルパー
  function clearMessages() {
    setError(null);
    setSuccessMsg(null);
  }

  // 新規追加フォームの送信ハンドラ
  async function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    clearMessages();
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await createCategory(formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      setSuccessMsg('カテゴリを追加しました');
      setShowAddForm(false);
      // 追加後はページを更新して最新一覧を取得する
      window.location.reload();
    });
  }

  // 編集フォームの送信ハンドラ
  async function handleUpdate(categoryId: string, e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    clearMessages();
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await updateCategory(categoryId, formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      setSuccessMsg('カテゴリを更新しました');
      setEditingId(null);
      window.location.reload();
    });
  }

  // 削除ハンドラ
  async function handleDelete(categoryId: string, categoryName: string) {
    // 確認ダイアログを出して誤操作を防ぐ
    if (
      !confirm(
        `「${categoryName}」を削除しますか？\n紐づく問い合わせのカテゴリ情報は空になります。`,
      )
    ) {
      return;
    }
    clearMessages();
    startTransition(async () => {
      const result = await deleteCategory(categoryId);
      if (result.error) {
        setError(result.error);
        return;
      }
      setCategories((prev) => prev.filter((c) => c.id !== categoryId));
      setSuccessMsg('カテゴリを削除しました');
    });
  }

  return (
    <div className="space-y-4">
      {/* エラーメッセージ */}
      {error && (
        <p
          role="alert"
          className="rounded-lg bg-rose-50 px-3 py-2.5 text-sm text-rose-700 ring-1 ring-rose-200"
        >
          {error}
        </p>
      )}
      {/* 成功メッセージ */}
      {successMsg && (
        <p
          role="status"
          aria-live="polite"
          className="rounded-lg bg-teal-50 px-3 py-2.5 text-sm text-teal-700 ring-1 ring-teal-200"
        >
          {successMsg}
        </p>
      )}

      {/* 登録済みカテゴリの一覧 */}
      {categories.length === 0 ? (
        <p className="text-sm text-slate-500">カテゴリはまだ登録されていません。</p>
      ) : (
        <ul className="space-y-2">
          {categories.map((cat) => (
            <li key={cat.id} className="rounded-lg border border-slate-200 bg-white p-3">
              {editingId === cat.id ? (
                // 編集中: インライン編集フォームを表示する
                <form onSubmit={(e) => handleUpdate(cat.id, e)} className="space-y-3">
                  {/* カテゴリ名入力 */}
                  <input
                    name="name"
                    type="text"
                    defaultValue={cat.name}
                    maxLength={100}
                    required
                    aria-label="カテゴリ名"
                    className={fieldClass}
                    placeholder="カテゴリ名"
                  />
                  {/* 保存・キャンセルボタン */}
                  <div className="flex items-center gap-2">
                    <button
                      type="submit"
                      disabled={isPending}
                      className="rounded-lg bg-teal-700 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-teal-800 disabled:opacity-50"
                    >
                      保存
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100"
                    >
                      キャンセル
                    </button>
                  </div>
                </form>
              ) : (
                // 通常表示: カテゴリ名 + 編集/削除ボタン
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-slate-900">{cat.name}</p>
                  {/* 操作ボタン: 編集 / 削除 */}
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        clearMessages();
                        setEditingId(cat.id);
                      }}
                      className="rounded px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100"
                    >
                      編集
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(cat.id, cat.name)}
                      disabled={isPending}
                      className="rounded px-2.5 py-1 text-xs font-medium text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
                    >
                      削除
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* 新規追加フォーム / 追加ボタン */}
      {showAddForm ? (
        <form
          onSubmit={handleCreate}
          className="space-y-3 rounded-lg border border-teal-200 bg-teal-50/40 p-4"
        >
          <p className="text-sm font-medium text-slate-700">新しいカテゴリを追加</p>
          {/* カテゴリ名入力 */}
          <input
            name="name"
            type="text"
            maxLength={100}
            required
            autoFocus
            aria-label="カテゴリ名"
            className={fieldClass}
            placeholder="カテゴリ名 (例: PCトラブル、複合機)"
          />
          {/* 追加・キャンセルボタン */}
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={isPending}
              className="rounded-lg bg-teal-700 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-teal-800 disabled:opacity-50"
            >
              {isPending ? '追加中…' : '追加する'}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowAddForm(false);
                clearMessages();
              }}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100"
            >
              キャンセル
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => {
            clearMessages();
            setShowAddForm(true);
            setEditingId(null);
          }}
          className="rounded-lg border border-dashed border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 transition hover:border-teal-400 hover:text-teal-700"
        >
          ＋ カテゴリを追加
        </button>
      )}
    </div>
  );
}
