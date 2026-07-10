'use client';

// /code-review ultra 指摘対応 (2026-07-10): InviteForm.tsx の SingleInviteForm と
// BulkInviteForm.tsx がほぼ同一の権限選択ラジオボタン群 (fieldset) を書き写していたため、
// 共通コンポーネントとして切り出す (§6 DRY)。

// 招待可能な権限の一覧と、その日本語ラベル (一元管理された定数)
import { INVITABLE_ROLES, ROLE_LABELS } from '@/lib/constants';
// 権限型 (requester | agent | admin)
import type { Role } from '@/domain/types';

// RoleRadioGroup の props
interface RoleRadioGroupProps {
  legend: string; // グループの目的を伝える凡例テキスト (スクリーンリーダー向け)
  name: string; // ラジオボタンの name 属性 (フォームごとに一意にする)
  value: Role; // 現在選択中の権限
  onChange: (role: Role) => void; // 選択変更時に呼ばれるコールバック
}

// 招待する人の権限 (メンバー / 担当者 / 管理者) を選ぶラジオボタン群
export function RoleRadioGroup({ legend, name, value, onChange }: RoleRadioGroupProps) {
  return (
    <fieldset className="space-y-2">
      {/* スクリーンリーダー向けにグループの目的を伝える凡例 */}
      <legend className="text-sm font-medium text-slate-700">{legend}</legend>
      <div className="flex flex-wrap gap-3">
        {INVITABLE_ROLES.map((r) => {
          // この選択肢が現在選択中か
          const isChecked = value === r;
          return (
            <label
              key={r}
              // 選択中はティールで強調する
              className={`flex cursor-pointer items-center gap-2 rounded-lg border px-4 py-2 text-sm transition ${
                isChecked
                  ? 'border-teal-400 bg-teal-50/60 ring-1 ring-teal-200'
                  : 'border-slate-200 bg-white hover:border-teal-200'
              }`}
            >
              {/* ラジオボタン本体 (name を揃えて単一選択にする) */}
              <input
                type="radio"
                name={name}
                value={r}
                checked={isChecked}
                onChange={() => onChange(r)}
                className="h-4 w-4 accent-teal-600"
              />
              {/* 権限ラベル (メンバー / 担当者) */}
              <span className="font-medium text-slate-800">{ROLE_LABELS[r]}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
