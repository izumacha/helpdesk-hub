'use client';

// 起票フォーム内に表示する「この FAQ で解決しませんか?」パネル (AI FAQ 自己解決 / §4.29)。
// 状態の保持・Server Action の呼び出しは親 (TicketForm) が担い、このコンポーネントは表示と
// ボタン操作の通知だけを行う (§10 ロジックと UI の分離)

// 提示する FAQ の型 (Server Action の戻り値と共有)
import type { SuggestedFaq } from '@/features/deflection/actions/deflection-actions';

// 受け取る props
interface Props {
  matches: SuggestedFaq[]; // 提示する FAQ (確信度順)
  resolved: boolean; // 「解決した」を選んだ後か (お礼表示に切り替える)
  busy: boolean; // 決着記録の送信中か (二重クリック防止)
  onResolved: () => void; // 「この回答で解決した」を押したとき
  onProceed: () => void; // 「解決しなかったので問い合わせを続ける」を押したとき
}

// FAQ 提案パネル本体
export function FaqSuggestionPanel({ matches, resolved, busy, onResolved, onProceed }: Props) {
  // 「解決した」を選んだ後はお礼と次の案内だけを出す (フォームは親が非表示にする)
  if (resolved) {
    return (
      <section
        aria-live="polite"
        className="rounded-xl bg-teal-50 px-4 py-4 text-sm text-teal-900 ring-1 ring-teal-200"
      >
        {/* 解決したことを明示し、問い合わせが登録されないことを伝える */}
        <p className="font-semibold">解決してよかったです。</p>
        <p className="mt-1 text-teal-800">
          この問い合わせは登録されません。ほかに困りごとがあれば、あらためて登録してください。
        </p>
      </section>
    );
  }

  return (
    // 提案パネル (見出しを付けて支援技術でも領域が分かるようにする)
    <section
      aria-labelledby="faq-suggestion-heading"
      className="rounded-xl bg-amber-50 px-4 py-4 ring-1 ring-amber-200"
    >
      {/* 見出し: 提案であることを明示 (AI が生成した文ではなく公開済み FAQ の引用であることも伝える) */}
      <h2 id="faq-suggestion-heading" className="text-sm font-semibold text-amber-900">
        似た内容の「よくある質問」があります
      </h2>
      <p className="mt-1 text-xs text-amber-800">
        登録前にご確認ください。回答は社内で公開済みの FAQ からそのまま引用しています。
      </p>

      {/* 提示する FAQ の一覧 (質問を見出し、回答は開閉式で表示) */}
      <ul className="mt-3 space-y-2">
        {matches.map((m) => (
          <li key={m.faqId} className="rounded-lg bg-white px-3 py-2 ring-1 ring-amber-100">
            {/* details/summary でキーボード操作・スクリーンリーダー対応の開閉を実現する (§7) */}
            <details>
              <summary className="cursor-pointer text-sm font-medium text-slate-900">
                {m.question}
              </summary>
              {/* 回答本文 (改行を保持して表示) */}
              <p className="mt-2 text-sm whitespace-pre-wrap text-slate-700">{m.answer}</p>
            </details>
          </li>
        ))}
      </ul>

      {/* 決着ボタン: 解決した / 問い合わせを続ける */}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={onProceed}
          disabled={busy}
          className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-amber-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
        >
          解決しなかったので問い合わせを続ける
        </button>
        <button
          type="button"
          onClick={onResolved}
          disabled={busy}
          aria-busy={busy}
          className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          この回答で解決した
        </button>
      </div>
    </section>
  );
}
