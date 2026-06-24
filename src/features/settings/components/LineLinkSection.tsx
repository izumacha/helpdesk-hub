'use client';

// React の状態フックと遷移フック (発行中のローディング表現に使う)
import { useState, useTransition } from 'react';
// LINE 連携のコード発行・解除サーバーアクション
import {
  generateLineLinkCode_action,
  unlinkLineAccount_action,
} from '@/features/settings/actions/link-line-account';

// このセクションが受け取る props (サーバーから現在の連携状態を渡す)
interface Props {
  connected: boolean; // 既に LINE と連携済みなら true
}

// LINE 連携の自己サービス UI (コード発行 → LINE 送信 → 連携、または解除)
export function LineLinkSection({ connected }: Props) {
  // サーバーアクション実行中フラグ (ボタンの二重押下防止・表示切替に使う)
  const [isPending, startTransition] = useTransition();
  // 発行された生コード (発行直後に 1 度だけ表示する。未発行なら null)
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  // コードの失効までの分数 (案内表示用)
  const [expiresInMinutes, setExpiresInMinutes] = useState<number | null>(null);
  // エラーメッセージ (サーバーアクションの日本語メッセージを表示)
  const [error, setError] = useState<string | null>(null);

  // 「コードを発行」ボタンの処理
  const handleGenerate = () => {
    // 直前のエラー表示をクリアしてから実行する
    setError(null);
    startTransition(async () => {
      try {
        // サーバーで生コードを発行し、画面に 1 度だけ表示する
        const result = await generateLineLinkCode_action();
        setIssuedCode(result.code);
        setExpiresInMinutes(result.expiresInMinutes);
      } catch (err) {
        // サーバーアクションの日本語エラーメッセージを表示する
        setError(err instanceof Error ? err.message : 'コードの発行に失敗しました');
      }
    });
  };

  // 「連携を解除」ボタンの処理
  const handleUnlink = () => {
    // 直前のエラー表示をクリアしてから実行する
    setError(null);
    startTransition(async () => {
      try {
        // サーバーで連携を解除する (成功後はページ再描画で未連携表示に戻る)
        await unlinkLineAccount_action();
        // 発行済みコードの残骸が画面に残らないようクリアする
        setIssuedCode(null);
        setExpiresInMinutes(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : '連携の解除に失敗しました');
      }
    });
  };

  // 連携済みの表示: 状態バッジ + 解除ボタン
  if (connected) {
    return (
      <div className="space-y-4">
        {/* 連携済みであることを色だけに頼らずテキストでも明示する (a11y: 状態は文言でも伝える) */}
        <p className="inline-flex items-center gap-2 rounded-lg bg-teal-50 px-3 py-2 text-sm font-medium text-teal-800 ring-1 ring-teal-100">
          <span aria-hidden="true">✓</span> LINE と連携済みです
        </p>
        <p className="text-sm text-slate-500">
          LINE から送った問い合わせが、あなたのアカウントの問い合わせとして記録され、
          一覧から自分で確認できます。
        </p>
        {/* 解除ボタン (実行中は無効化) */}
        <button
          type="button"
          onClick={handleUnlink}
          disabled={isPending}
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isPending ? '処理中…' : '連携を解除する'}
        </button>
        {/* エラー表示 (アイコン + テキストで色のみに依存しない) */}
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
      </div>
    );
  }

  // 未連携の表示: 手順 + コード発行ボタン + 発行後のコード表示
  return (
    <div className="space-y-4">
      {/* 連携手順を番号付きリストで案内する (h2 はページ側にあるので、ここは段落 + ol) */}
      <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600">
        <li>LINE で組織の公式アカウントを友だち追加します。</li>
        <li>下の「コードを発行」を押し、表示されたコードを LINE のトークに送信します。</li>
        <li>送信後、この画面を再読み込みすると「連携済み」に変わります。</li>
      </ol>

      {/* コード発行ボタン (実行中は無効化) */}
      <button
        type="button"
        onClick={handleGenerate}
        disabled={isPending}
        className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isPending ? '発行中…' : 'コードを発行'}
      </button>

      {/* 発行された生コードの表示 (発行直後の 1 度だけ。再読込で消える) */}
      {issuedCode && (
        <div className="space-y-1 rounded-lg bg-slate-50 p-4 ring-1 ring-slate-200">
          <p className="text-sm text-slate-500">このコードを LINE のトークに送信してください:</p>
          {/* コードは等幅・大きめで誤読を防ぐ。aria-label で読み上げ向けに補足する */}
          <p
            className="font-mono text-2xl font-bold tracking-widest text-slate-900"
            aria-label="連携コード"
          >
            {issuedCode}
          </p>
          {expiresInMinutes != null && (
            <p className="text-xs text-slate-500">
              有効期限: 発行から約 {expiresInMinutes} 分です。期限が切れたら再発行してください。
            </p>
          )}
        </div>
      )}

      {/* エラー表示 */}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
