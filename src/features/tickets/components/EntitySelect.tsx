'use client';

// React フック (送信中トランジション/エラー表示用ローカル状態)
import { useState, useTransition } from 'react';
// 失敗時にサーバーの最新状態を取り直すためのルーター
import { useRouter } from 'next/navigation';

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
  // 選択変更時に呼ばれる (空文字は null に正規化済み)。呼び出し先のサーバーアクション
  // (updateTicketAssignee 等) は Promise を返す非同期関数なので、戻り値の型に Promise<void> も許容する
  onChange: (newId: string | null) => void | Promise<void>;
  // このセレクトの意味を伝える可視ラベル (呼び出し元ページの dt 要素) の id。
  // フォローアップ (2026-07-16 #2): §4.8 で残していた a11y ギャップ (label 関連付け欠如) の解消
  labelledBy: string;
}

// チケット詳細ページの各種プルダウン (担当者/カテゴリ/拠点) が共有する汎用セレクト。
// /code-review ultra 指摘対応: AssigneeSelect/CategorySelect/LocationSelect が
// 「useTransition で送信中を管理し、選択変更でサーバーアクションを呼ぶ」という同型の
// プルダウンを個別に複製していた (3 箇所目の重複) ため、表示ロジックだけを共通化する
// (§6 DRY)。呼び出すサーバーアクションはフィールドごとに異なるため、呼び出し自体は
// 各ラッパーコンポーネント (AssigneeSelect 等) の責務として残す。
//
// フォローアップ (2026-07-16): update-ticket.ts の updateTicketAssignee/Category/Location は
// レート制限超過・チケット消失・指定先の不在 (他エージェントによる削除等) で Error を throw するが、
// このセレクトは startTransition に渡すコールバックの戻り値 (onChange が返す Promise) を
// 誰も待たず・捕捉していなかったため未処理の Promise 拒否になっていた。StatusSelect/PrioritySelect
// (フォローアップ 2026-07-15 #3) と FaqStatusButton (フォローアップ 2026-07-15) で先に直した
// 「送信中は無効化し、エラーはその場に表示、競合時は router.refresh() で最新化する」パターンを
// ここにも適用する。
//
// フォローアップ (2026-07-16 #2): §4.8 のこの直前のコメントブロックが「別途 5 種まとめて対応する」と
// 明記して残していた a11y ギャップ (この select がどの dt の値を表すか、プログラム的な関連付けが
// 無かった) の解消。呼び出し元ページの dt に振った id を labelledBy として受け取り、
// aria-labelledby として select に渡す。
export function EntitySelect({ currentId, options, emptyLabel, onChange, labelledBy }: Props) {
  // 失敗時にサーバーの最新状態を取り直すためのルーター
  const router = useRouter();
  // 送信中フラグ + トランジション関数
  const [isPending, startTransition] = useTransition();
  // サーバーアクションから返ったエラーを表示する
  const [error, setError] = useState<string | null>(null);

  // 選択変更時に onChange を呼ぶ (空文字は null に正規化する)。失敗時はその場にエラー表示する
  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value;
    // 直前のエラー表示をクリア
    setError(null);
    startTransition(async () => {
      try {
        // onChange が返す Promise を待ち、拒否 (throw) を確実に捕捉する
        await onChange(val || null);
      } catch (err) {
        // 失敗時 (競合・レート制限・指定先の不在等) はエラーメッセージを画面表示 (§6 エラーを握り潰さない)
        setError(err instanceof Error ? err.message : 'エラーが発生しました');
        // 競合エラーは「画面の表示が古い」ことを意味するため、サーバーの最新状態を取り直して
        // 古いプルダウンの値が残り続けるのを防ぐ (エラー時は revalidatePath に到達しないため
        // クライアント側で再取得する)
        router.refresh();
      }
    });
  }

  return (
    <div>
      {/* 現在値を表示しつつ、変更で更新するセレクト */}
      <select
        value={currentId ?? ''}
        onChange={handleChange}
        disabled={isPending}
        aria-labelledby={labelledBy}
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
      {/* エラー表示 (ある場合のみ。role="alert" でスクリーンリーダーにも即時に伝える。§7 a11y) */}
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
