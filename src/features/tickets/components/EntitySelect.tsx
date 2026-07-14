'use client';

// 非ブロッキングで状態更新を扱う React フック
import { useTransition } from 'react';

// プルダウン項目の型 (ID と表示名のみを要求する)
export interface EntityOption {
  id: string;
  name: string;
}

// 受け取る props (現在値/候補一覧/未選択時ラベル/選択変更ハンドラ)
interface Props {
  currentId: string | null;
  options: EntityOption[];
  emptyLabel: string; // 空文字 (未選択) のときに表示するラベル (例: '未割当' '未分類' '未指定')
  onChange: (newId: string | null) => void; // 選択変更時に呼ばれる (空文字は null に正規化済み)
}

// チケット詳細ページの各種プルダウン (担当者/カテゴリ/拠点) が共有する汎用セレクト。
// /code-review ultra 指摘対応: AssigneeSelect/CategorySelect/LocationSelect が
// 「useTransition で送信中を管理し、選択変更でサーバーアクションを呼ぶ」という同型の
// プルダウンを個別に複製していた (3 箇所目の重複) ため、表示ロジックだけを共通化する
// (§6 DRY)。呼び出すサーバーアクションはフィールドごとに異なるため、呼び出し自体は
// 各ラッパーコンポーネント (AssigneeSelect 等) の責務として残す。
export function EntitySelect({ currentId, options, emptyLabel, onChange }: Props) {
  // 送信中フラグ + トランジション関数
  const [isPending, startTransition] = useTransition();

  // 選択変更時に onChange を呼ぶ (空文字は null に正規化する)
  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value;
    startTransition(() => onChange(val || null));
  }

  return (
    // 現在値を表示しつつ、変更で更新するセレクト
    <select
      value={currentId ?? ''}
      onChange={handleChange}
      disabled={isPending}
      className="rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50"
    >
      {/* 空文字 = 未選択 */}
      <option value="">{emptyLabel}</option>
      {/* 候補一覧 */}
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}
