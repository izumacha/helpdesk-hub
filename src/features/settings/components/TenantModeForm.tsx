'use client';

// 非ブロッキングでサーバーアクションを呼ぶためのフックと状態管理フック
import { useState, useTransition } from 'react';
// 画面再描画 (revalidate 後の最新値反映) のためのルーター
import { useRouter } from 'next/navigation';
// テナントモード切替のサーバーアクション
import { updateTenantMode } from '@/features/settings/actions/update-tenant-mode';
// モードの一覧・ラベル・説明文 (一元管理された定数)
import { TENANT_MODES, TENANT_MODE_LABELS, TENANT_MODE_DESCRIPTIONS } from '@/lib/constants';
// テナントモード型 (lite | pro)
import type { TenantMode } from '@/domain/types';

// 受け取る props (現在のテナントモード)
interface Props {
  current: TenantMode;
}

// Lite / Pro モードを切り替えるフォーム (ラジオ選択 + 保存ボタン)
export function TenantModeForm({ current }: Props) {
  // 送信中フラグ + トランジション (二重送信防止・ボタン無効化に使う)
  const [isPending, startTransition] = useTransition();
  // 再描画用ルーター
  const router = useRouter();
  // フォーム上で選択中のモード (初期値は現在のモード)
  const [selected, setSelected] = useState<TenantMode>(current);
  // 保存成功メッセージの表示フラグ
  const [saved, setSaved] = useState(false);
  // エラーメッセージ (サーバーアクションが throw した日本語メッセージを表示)
  const [error, setError] = useState<string | null>(null);

  // フォーム送信ハンドラ (デフォルトのページ遷移を止めてアクションを呼ぶ)
  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    // ブラウザ既定の送信 (フルリロード) を抑止する
    e.preventDefault();
    // 直近のメッセージをリセット
    setSaved(false);
    setError(null);
    // 送信する FormData を組み立てる (name="mode" に選択値を載せる)
    const formData = new FormData();
    formData.set('mode', selected);
    // トランジション内でサーバーアクションを実行
    startTransition(async () => {
      try {
        // テナントモードを更新 (失敗時は throw されるので catch で拾う)
        await updateTenantMode(formData);
        // 成功表示を出し、サーバー側の最新状態を反映するため再描画する
        setSaved(true);
        router.refresh();
      } catch (err) {
        // サーバーアクションの日本語エラーメッセージを表示 (詳細はクライアントに出さない)
        setError(err instanceof Error ? err.message : '保存に失敗しました');
      }
    });
  }

  return (
    // 保存処理は handleSubmit に集約 (JS 無効時も name=mode が送られるよう form を使う)
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* モード選択ラジオ (各モードのラベル + 説明文をカードで表示) */}
      <fieldset className="space-y-3">
        {/* スクリーンリーダー向けにグループの目的を伝える凡例 */}
        <legend className="text-sm font-medium text-slate-700">動作モードを選択</legend>
        {TENANT_MODES.map((mode) => {
          // この選択肢が現在選択中か
          const isChecked = selected === mode;
          return (
            <label
              key={mode}
              // 選択中はティールで強調し、クリック範囲をカード全体に広げる
              className={`flex cursor-pointer gap-3 rounded-xl border p-4 transition ${
                isChecked
                  ? 'border-teal-400 bg-teal-50/60 ring-1 ring-teal-200'
                  : 'border-slate-200 bg-white hover:border-teal-200'
              }`}
            >
              {/* ラジオボタン本体 (name を揃えて単一選択にする) */}
              <input
                type="radio"
                name="mode"
                value={mode}
                checked={isChecked}
                onChange={() => setSelected(mode)}
                className="mt-1 h-4 w-4 accent-teal-600"
              />
              {/* ラベル + 説明文 */}
              <span className="space-y-1">
                {/* モード名 (例: かんたんモード（Lite）) */}
                <span className="block text-sm font-semibold text-slate-900">
                  {TENANT_MODE_LABELS[mode]}
                </span>
                {/* モードの説明文 */}
                <span className="block text-xs text-slate-500">{TENANT_MODE_DESCRIPTIONS[mode]}</span>
              </span>
            </label>
          );
        })}
      </fieldset>

      {/* 成功メッセージ (aria-live でスクリーンリーダーに即時通知) */}
      {saved && (
        <p className="text-sm text-teal-700" role="status" aria-live="polite">
          モードを保存しました。
        </p>
      )}
      {/* エラーメッセージ (色だけでなくテキストでも状態を伝える) */}
      {error && (
        <p className="text-sm text-rose-700" role="alert">
          {error}
        </p>
      )}

      {/* 保存ボタン (選択が現在値と同じ or 送信中は無効化) */}
      <button
        type="submit"
        disabled={isPending || selected === current}
        className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? '保存中…' : '保存する'}
      </button>
    </form>
  );
}
