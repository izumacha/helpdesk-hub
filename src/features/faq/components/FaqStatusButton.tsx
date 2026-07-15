'use client';

// React フック (トランジション/ローカル状態)
import { useState, useTransition } from 'react';
// 失敗時にサーバーの最新状態を取り直すためのルーター
import { useRouter } from 'next/navigation';
// FAQ の状態を公開/却下 (非公開) に切り替えるサーバーアクション
import { updateFaqStatus } from '@/features/faq/actions/faq-actions';

// このボタンが受け取る props (対象 FAQ・遷移先状態・表示文言・見た目)
interface Props {
  // 対象の FAQ 候補 ID
  faqId: string;
  // 遷移先の状態 (公開 or 却下/非公開)
  nextStatus: 'Published' | 'Rejected';
  // ボタンの表示文言 (例: 「公開する」「却下」「非公開にする」)
  label: string;
  // スクリーンリーダー向けのアクセシブルネーム (一覧内で対象を区別するため質問文を含める。§7 a11y)
  ariaLabel: string;
  // ボタンの見た目 (呼び出し元ごとにデザインが異なるため丸ごと渡す)
  className: string;
}

// フォローアップ (2026-07-15): 以前は `<form action={updateFaqStatus.bind(...)}>` の素の
// フォームで、送信中もボタンが押せるうえアクションの throw を誰も捕捉しなかったため、
// 二重クリックや競合 (別のエージェントが先に状態を変更) でページ全体が未処理エラー画面に
// 落ちていた。FaqInlineForm と同じく送信中はボタンを無効化し、エラーはその場に表示する
export function FaqStatusButton({ faqId, nextStatus, label, ariaLabel, className }: Props) {
  // 失敗時にサーバーの最新状態を取り直すためのルーター
  const router = useRouter();
  // 送信中フラグ + トランジション関数 (送信中はボタンを無効化して二重送信を防ぐ)
  const [isPending, startTransition] = useTransition();
  // サーバーアクションから返ったエラーを表示する
  const [error, setError] = useState<string | null>(null);

  // クリックハンドラ (非同期でサーバーアクションを呼び、失敗時はその場にエラー表示)
  function handleClick() {
    // 直前のエラー表示をクリア
    setError(null);
    // 非ブロッキングで実行 (UI が固まらない)
    startTransition(async () => {
      try {
        // 状態変更のサーバーアクションを実行 (成功時は revalidatePath('/faq') で一覧が更新される)
        await updateFaqStatus(faqId, nextStatus);
      } catch (err) {
        // 失敗時 (競合・レート制限等) はエラーメッセージを画面表示 (§6 エラーを握り潰さない)
        setError(err instanceof Error ? err.message : 'エラーが発生しました');
        // 競合エラーは「画面の表示が古い」ことを意味するため、サーバーの最新状態を取り直して
        // 古いボタンが残り続けるのを防ぐ (エラー時のアクションは revalidatePath に到達しないため
        // クライアント側で再取得する)
        router.refresh();
      }
    });
  }

  return (
    <div>
      {/* 状態変更ボタン (送信中は無効化して二重送信を防ぐ) */}
      <button
        type="button"
        onClick={handleClick}
        aria-label={ariaLabel}
        disabled={isPending}
        className={`${className} disabled:pointer-events-none disabled:opacity-50`}
      >
        {/* 送信中は「処理中...」に差し替える (「公開する中...」のような不自然な合成語を避ける) */}
        {isPending ? '処理中...' : label}
      </button>
      {/* エラー表示 (ある場合のみ。role="alert" でスクリーンリーダーにも即時に伝える。§7 a11y) */}
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
