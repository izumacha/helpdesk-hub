'use client';

// React フック (タブ切替状態を管理)
import { useState } from 'react';
// 各タブの中身 (パスワードフォーム / マジックリンク要求フォーム)
import { MagicLinkRequestForm } from './MagicLinkRequestForm';
import { PasswordLoginForm } from './PasswordLoginForm';

// LoginTabs の props 型 (Server Component 側からマジックリンク失敗フラグを受け取る)
interface LoginTabsProps {
  initialError?: string; // 例: マジックリンク認証失敗から戻った直後に表示するメッセージ
}

// 「パスワードでログイン」と「メールでログイン」の 2 タブを切り替えるラッパ
export function LoginTabs({ initialError }: LoginTabsProps) {
  // 現在表示中のタブ。既定はパスワード経路 (E2E 互換性のため、メール優先にしない)
  const [tab, setTab] = useState<'password' | 'magic'>('password');

  // 各タブのボタンに付けるベース class (アクティブ判定で色を切り替える)
  function tabButtonClass(active: boolean): string {
    return [
      'flex-1 rounded-md px-3 py-2 text-sm font-medium transition',
      active
        ? 'bg-white text-teal-800 shadow-sm ring-1 ring-slate-200'
        : 'text-slate-600 hover:text-slate-900',
    ].join(' ');
  }

  return (
    <div className="space-y-6">
      {/* タブの見出し (role="tablist" でスクリーンリーダーに伝える) */}
      <div role="tablist" aria-label="ログイン方法" className="flex gap-1 rounded-lg bg-slate-100 p-1">
        {/* パスワードタブのボタン */}
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'password'}
          aria-controls="login-panel-password"
          id="login-tab-password"
          onClick={() => setTab('password')}
          className={tabButtonClass(tab === 'password')}
        >
          パスワードでログイン
        </button>
        {/* マジックリンクタブのボタン */}
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'magic'}
          aria-controls="login-panel-magic"
          id="login-tab-magic"
          onClick={() => setTab('magic')}
          className={tabButtonClass(tab === 'magic')}
        >
          メールでログイン
        </button>
      </div>

      {/* アクティブな経路のフォームだけを DOM に出す (hidden 属性ではなく条件レンダリング)。
          - 同じラベル "メールアドレス" を持つ input が 2 つ並ぶと Playwright の getByLabel が
            strict mode 違反で落ちる (E2E 共有 login ヘルパー互換性のため必須)
          - タブ切替時にフォーム入力状態が失われるが、本フローは入力 1〜2 項目で許容範囲 */}
      {tab === 'password' ? (
        <div
          role="tabpanel"
          id="login-panel-password"
          aria-labelledby="login-tab-password"
        >
          <PasswordLoginForm initialError={initialError} />
        </div>
      ) : (
        <div role="tabpanel" id="login-panel-magic" aria-labelledby="login-tab-magic">
          <MagicLinkRequestForm />
        </div>
      )}
    </div>
  );
}
