'use client';

// React フック (エラー状態/送信中トランジション)
import { useState, useTransition } from 'react';
// 失敗時にサーバーの最新状態を取り直すためのルーター
import { useRouter } from 'next/navigation';
// ステータス更新サーバーアクション
import { updateTicketStatus } from '@/features/tickets/actions/update-ticket';
// ステータスの日本語ラベルを mode (lite | pro) に応じて返す mode-aware ヘルパー
import { getStatusLabel } from '@/lib/constants';
// 現ステータスから許可される遷移先一覧を返すドメイン関数 (mode に応じて Lite/Pro 表を切替)
import { getAllowedTransitions } from '@/domain/ticket-status';
// ステータス型 (正準のドメイン型)
import type { TicketStatus } from '@/domain/types';
// テナントモード型 (lite | pro)。ラベルと遷移表の切替に使う
import type { TenantMode } from '@/domain/types';

// 受け取る props (チケット ID と現在ステータスと、表示切替用テナントモード)
interface Props {
  ticketId: string;
  current: TicketStatus;
  mode: TenantMode;
  // このセレクトの意味を伝える可視ラベル (dt 要素) の id。
  // フォローアップ (2026-07-16 #2): §4.8 で「別途 5 種まとめて対応する」と明記していた
  // a11y ギャップ (フォーム入力に対応する <label>/aria-labelledby が無い) の解消
  labelledBy: string;
}

// フォローアップ (2026-07-15 #3): updateTicketStatus は check-then-act 競合時に
// Error を throw するようになったが (他の操作と競合したため変更できませんでした)、
// このセレクトは throw を誰も捕捉しておらず未処理の Promise 拒否になっていた
// (FaqStatusButton と同じく、送信中はセレクトを無効化しエラーはその場に表示する)
// ステータスを切り替えるプルダウン (許可された遷移のみ表示)
export function StatusSelect({ ticketId, current, mode, labelledBy }: Props) {
  // 失敗時にサーバーの最新状態を取り直すためのルーター
  const router = useRouter();
  // 送信中フラグ + トランジション
  const [isPending, startTransition] = useTransition();
  // サーバーアクションから返ったエラーを表示する
  const [error, setError] = useState<string | null>(null);
  // 現状から遷移可能な次状態の一覧 (mode に応じて Lite なら 3 値遷移表、Pro なら 7 値遷移表)
  const allowed = getAllowedTransitions(current, mode);

  // 選択変更でアクションを呼ぶ (競合・レート制限等の失敗はその場にエラー表示する)
  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as TicketStatus;
    // 直前のエラー表示をクリア
    setError(null);
    startTransition(async () => {
      try {
        await updateTicketStatus(ticketId, next);
      } catch (err) {
        // 失敗時はエラーメッセージを画面表示 (§6 エラーを握り潰さない)
        setError(err instanceof Error ? err.message : 'エラーが発生しました');
        // 競合エラーは「画面の表示が古い」ことを意味するため、サーバーの最新状態を取り直して
        // 古いプルダウンの値が残り続けるのを防ぐ
        router.refresh();
      }
    });
  }

  // 遷移先が無いならプルダウン自体を出さない
  if (allowed.length === 0) return null;

  return (
    <div>
      <select
        value={current}
        onChange={handleChange}
        disabled={isPending}
        aria-labelledby={labelledBy}
        className="rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50"
      >
        {/* 現在値はプレースホルダ的に disabled で表示 (mode に応じて Lite/Pro ラベル) */}
        <option value={current} disabled>
          {getStatusLabel(current, mode)}
        </option>
        {/* 許可された遷移先のみを option として並べる (mode に応じて Lite/Pro ラベル) */}
        {allowed.map((s) => (
          <option key={s} value={s}>
            {getStatusLabel(s, mode)}
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
