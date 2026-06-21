'use client';

// Phase 4 多拠点: テナント内の拠点一覧を管理する Client Component。
// 管理者が拠点の追加・編集・削除を行うための UI を提供する。
// docs/smb-dx-pivot-plan.md §5.2「多店舗・多拠点対応」

// React の状態管理・副作用フック
import { useState, useTransition } from 'react';
// 拠点操作の Server Actions
import { createLocation } from '@/features/settings/actions/create-location';
import { updateLocation } from '@/features/settings/actions/update-location';
import { deleteLocation } from '@/features/settings/actions/delete-location';
// ドメイン型 (Location)
import type { Location } from '@/domain/types';

// 受け取る props (初期の拠点一覧)
interface Props {
  // 現在のテナントに登録されている拠点一覧 (名前昇順)
  locations: Location[];
}

// 入力欄に共通で当てるベースクラス
const fieldClass =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500';

// 拠点管理セクション (一覧表示 + 追加フォーム + 編集/削除)
export function LocationsSection({ locations: initialLocations }: Props) {
  // ローカルで拠点一覧を保持して追加/削除を即時反映する
  const [locations, setLocations] = useState<Location[]>(initialLocations);
  // 新規追加フォームの表示フラグ
  const [showAddForm, setShowAddForm] = useState(false);
  // 編集中の拠点 ID (null なら非編集モード)
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
    // ブラウザデフォルト送信を抑止
    e.preventDefault();
    clearMessages();
    // フォームデータを取り出して Server Action に渡す
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await createLocation(formData);
      if (result.error) {
        // エラーを表示して中断
        setError(result.error);
        return;
      }
      // 成功: フォームをリセットしてページをリロードして一覧を最新にする
      // (サーバー側の revalidatePath を使う代わりにシンプルに再読み込み)
      setSuccessMsg('拠点を追加しました');
      setShowAddForm(false);
      // 追加後はページを更新して最新一覧を取得する
      window.location.reload();
    });
  }

  // 編集フォームの送信ハンドラ
  async function handleUpdate(locationId: string, e: React.FormEvent<HTMLFormElement>) {
    // ブラウザデフォルト送信を抑止
    e.preventDefault();
    clearMessages();
    // フォームデータを取り出して Server Action に渡す
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await updateLocation(locationId, formData);
      if (result.error) {
        // エラーを表示して中断
        setError(result.error);
        return;
      }
      // 成功: 編集モードを終了してページをリロード
      setSuccessMsg('拠点を更新しました');
      setEditingId(null);
      window.location.reload();
    });
  }

  // 削除ハンドラ
  async function handleDelete(locationId: string, locationName: string) {
    // 確認ダイアログを出して誤操作を防ぐ
    if (!confirm(`「${locationName}」を削除しますか？\n紐づく問い合わせの拠点情報は空になります。`)) {
      return;
    }
    clearMessages();
    startTransition(async () => {
      const result = await deleteLocation(locationId);
      if (result.error) {
        // エラーを表示して中断
        setError(result.error);
        return;
      }
      // 成功: ローカル一覧から削除して即時反映
      setLocations((prev) => prev.filter((l) => l.id !== locationId));
      setSuccessMsg('拠点を削除しました');
    });
  }

  return (
    <div className="space-y-4">
      {/* エラーメッセージ */}
      {error && (
        <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2.5 text-sm text-rose-700 ring-1 ring-rose-200">
          {error}
        </p>
      )}
      {/* 成功メッセージ */}
      {successMsg && (
        <p role="status" aria-live="polite" className="rounded-lg bg-teal-50 px-3 py-2.5 text-sm text-teal-700 ring-1 ring-teal-200">
          {successMsg}
        </p>
      )}

      {/* 登録済み拠点の一覧 */}
      {locations.length === 0 ? (
        // 拠点が未登録の場合は空状態を表示
        <p className="text-sm text-slate-400">拠点はまだ登録されていません。</p>
      ) : (
        <ul className="space-y-2">
          {locations.map((loc) => (
            <li key={loc.id} className="rounded-lg border border-slate-200 bg-white p-3">
              {editingId === loc.id ? (
                // 編集中: インライン編集フォームを表示する
                <form onSubmit={(e) => handleUpdate(loc.id, e)} className="space-y-3">
                  {/* 拠点名入力 */}
                  <input
                    name="name"
                    type="text"
                    defaultValue={loc.name}
                    maxLength={100}
                    required
                    aria-label="拠点名"
                    className={fieldClass}
                    placeholder="拠点名"
                  />
                  {/* 説明入力 (任意) */}
                  <input
                    name="description"
                    type="text"
                    defaultValue={loc.description ?? ''}
                    maxLength={200}
                    aria-label="拠点の説明"
                    className={fieldClass}
                    placeholder="説明 (任意)"
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
                // 通常表示: 拠点名 + 説明 + 編集/削除ボタン
                <div className="flex items-start justify-between gap-3">
                  <div>
                    {/* 拠点名 */}
                    <p className="text-sm font-medium text-slate-900">{loc.name}</p>
                    {/* 説明がある場合のみ表示 */}
                    {loc.description && (
                      <p className="mt-0.5 text-xs text-slate-500">{loc.description}</p>
                    )}
                  </div>
                  {/* 操作ボタン: 編集 / 削除 */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        clearMessages();
                        setEditingId(loc.id);
                      }}
                      className="rounded px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100"
                    >
                      編集
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(loc.id, loc.name)}
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
        // 追加フォームを表示中
        <form onSubmit={handleCreate} className="space-y-3 rounded-lg border border-teal-200 bg-teal-50/40 p-4">
          <p className="text-sm font-medium text-slate-700">新しい拠点を追加</p>
          {/* 拠点名入力 */}
          <input
            name="name"
            type="text"
            maxLength={100}
            required
            autoFocus
            aria-label="拠点名"
            className={fieldClass}
            placeholder="拠点名 (例: 渋谷本店、第一工場)"
          />
          {/* 説明入力 (任意) */}
          <input
            name="description"
            type="text"
            maxLength={200}
            aria-label="拠点の説明"
            className={fieldClass}
            placeholder="説明 (任意)"
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
        // 追加フォームが非表示の場合は「＋ 拠点を追加」ボタンを表示する
        <button
          type="button"
          onClick={() => {
            clearMessages();
            setShowAddForm(true);
            setEditingId(null);
          }}
          className="rounded-lg border border-dashed border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 transition hover:border-teal-400 hover:text-teal-700"
        >
          ＋ 拠点を追加
        </button>
      )}
    </div>
  );
}
