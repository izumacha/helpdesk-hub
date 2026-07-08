'use client';

// メール取り込み用の転送先アドレス (inboundToken) を (再)発行するボタン。
// 未発行テナントの初回発行と、既存アドレス漏洩時の再発行 (ローテーション) を兼ねる。
// docs/smb-dx-pivot-plan.md §4 Phase 2「メール取り込み」フォローアップ。

// 送信中フラグ管理・非ブロッキング実行のためのフック
import { useState, useTransition } from 'react';
// 画面再描画 (revalidate 後の最新値反映) のためのルーター
import { useRouter } from 'next/navigation';
// トークン (再)発行のサーバーアクション
import { regenerateInboundToken } from '@/features/settings/actions/regenerate-inbound-token';

// 受け取る props (既存アドレスの有無で確認文言・ボタン文言を出し分ける)
interface Props {
  hasExisting: boolean; // true なら「再発行 (既存アドレス失効)」、false なら「新規発行」
}

// メール取り込み用転送先アドレスの (再)発行ボタン本体
export function RegenerateInboundTokenButton({ hasExisting }: Props) {
  // 送信中フラグ + トランジション (二重送信防止・ボタン無効化に使う)
  const [isPending, startTransition] = useTransition();
  // 再描画用ルーター (成功後に最新の転送先アドレスを反映する)
  const router = useRouter();
  // エラーメッセージ (サーバーアクションが throw した日本語メッセージを表示)
  const [error, setError] = useState<string | null>(null);

  // ボタン押下ハンドラ
  function handleClick() {
    // 既存アドレスがある場合のみ「失効する」旨の確認を挟む (誤操作防止)。
    // 未発行テナントには何も失効しないため確認は不要
    if (
      hasExisting &&
      !window.confirm(
        '転送先アドレスを再発行しますか？ 現在のアドレスは直ちに無効になり、そこへの転送は届かなくなります。',
      )
    ) {
      return;
    }
    // 直近のエラーをリセット
    setError(null);
    // トランジション内でサーバーアクションを実行
    startTransition(async () => {
      try {
        // トークンを (再)発行する (失敗時は throw されるので catch で拾う)
        await regenerateInboundToken();
        // 発行結果 (新しい転送先アドレス) を反映するため再描画する
        router.refresh();
      } catch (err) {
        // サーバーアクションの日本語エラーメッセージを表示
        setError(err instanceof Error ? err.message : '発行に失敗しました');
      }
    });
  }

  return (
    <div className="space-y-2">
      {/* エラーメッセージ (色だけでなくテキストでも状態を伝える) */}
      {error && (
        <p className="text-sm text-rose-700" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? '発行中…' : hasExisting ? 'アドレスを再発行する' : '転送先アドレスを発行する'}
      </button>
    </div>
  );
}
