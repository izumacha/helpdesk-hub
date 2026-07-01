// 現在のセッション取得
import { auth } from '@/lib/auth';
// 認証エラー時のリダイレクト
import { redirect } from 'next/navigation';
// リポジトリ束 (監査ログ取得に使用)
import { repos } from '@/data';
// 日付フォーマットヘルパー (年月日時分秒を JST で表示する)
import { formatDateTimeJP } from '@/lib/format-date';
// 履歴フィールドの日本語ラベル
import { HISTORY_FIELD_LABELS } from '@/lib/constants';
// CSV エクスポートボタン (Client Component)
import { AuditExportButton } from '@/features/audit/components/AuditExportButton';
// 監査ログ機能のプランゲート (§6.1 料金プラン: Pro / Enterprise のみ利用可能)
import { isAuditLogAllowed } from '@/lib/plan-guard';
// テナントの現在プランを解決する共通ヘルパー (複数箇所での重複を避ける)
import { resolveTenantPlan } from '@/lib/tenant-plan';

// 一覧の取得件数上限 (パフォーマンス保護: 画面表示は 200 件まで)
const PAGE_LIMIT = 200;

// 監査ログページ (管理者専用)
// テナント全体のチケット変更履歴を一覧表示する。Phase 4「監査ログ / バックアップ自動化」に対応。
export default async function AuditPage() {
  // セッション取得 (middleware で未ログインは弾かれている前提)
  const session = await auth();
  // 未ログイン or tenantId 不在はログインページへリダイレクトする
  // (middleware が先に弾く想定だが、JWT 移行期間中などセッション破損ケースの防御的処理)
  if (!session?.user?.id || !session.user.tenantId) redirect('/login');

  // 管理者以外は権限なし表示を返す (RBAC はページ側で強制する)
  if (session.user.role !== 'admin') {
    return (
      <div className="rounded-2xl bg-white py-20 text-center text-slate-400 ring-1 ring-slate-200">
        <p className="text-sm">この画面は管理者のみ利用できます。</p>
      </div>
    );
  }

  // 監査ログはプランゲート対象の機能 (Pro / Enterprise のみ)。テナントの現在プランを確認する
  // (UI 非表示だけに頼らずサーバー側で強制する §9)
  const plan = await resolveTenantPlan(session.user.tenantId);
  if (!isAuditLogAllowed(plan)) {
    return (
      <div className="rounded-2xl bg-white py-20 text-center text-slate-400 ring-1 ring-slate-200">
        <p className="text-sm">
          監査ログは Pro / Enterprise プランでご利用いただけます。設定画面からプランをアップグレードしてください。
        </p>
      </div>
    );
  }

  // テナント全体の変更履歴を新しい順に取得する (上限 PAGE_LIMIT 件)
  const logs = await repos.history.findAllByTenant({
    tenantId: session.user.tenantId, // セッション由来の tenantId のみ使用 (クロステナント漏洩防止)
    limit: PAGE_LIMIT,
  });

  return (
    <div className="space-y-6">
      {/* ページヘッダー */}
      <div className="flex items-start justify-between gap-4">
        <div>
          {/* ページタイトル */}
          <h1 className="text-2xl font-bold text-slate-900">監査ログ</h1>
          {/* 説明文: 何が表示されているかを伝える */}
          <p className="mt-1 text-sm text-slate-500">
            組織内のチケット変更履歴を表示しています。最新 {PAGE_LIMIT} 件。
          </p>
        </div>
        {/* CSV エクスポートボタン (Client Component) */}
        <AuditExportButton logs={logs} />
      </div>

      {/* ログが 0 件の場合の空状態表示 */}
      {logs.length === 0 ? (
        <div className="rounded-2xl bg-white py-20 text-center text-slate-400 ring-1 ring-slate-200">
          <p className="text-sm">変更履歴がまだありません。</p>
        </div>
      ) : (
        // テーブルラッパー (横スクロール対応)
        <div className="overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-slate-100">
          <table className="min-w-full divide-y divide-slate-200" aria-label="変更履歴の一覧">
            <thead className="bg-slate-50">
              <tr>
                {/* 各列ヘッダー (scope="col" でスクリーンリーダーに列見出しを伝える) */}
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  日時
                </th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  担当者
                </th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  問い合わせ
                </th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  項目
                </th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  変更前
                </th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  変更後
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {logs.map((log) => (
                <tr key={log.id} className="hover:bg-slate-50/60 transition-colors">
                  {/* 変更日時 (フォーマット済み) */}
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-500">
                    <time dateTime={log.createdAt.toISOString()}>
                      {formatDateTimeJP(log.createdAt)}
                    </time>
                  </td>
                  {/* 変更を行ったユーザー名 */}
                  <td className="px-4 py-3 text-sm font-medium text-slate-900">
                    {log.changedByName}
                  </td>
                  {/* 対象チケット件名 (チケット詳細へのリンク) */}
                  <td className="max-w-xs px-4 py-3 text-sm text-slate-700">
                    <a
                      href={`/tickets/${log.ticketId}`}
                      className="line-clamp-1 hover:text-teal-700 hover:underline"
                    >
                      {log.ticketTitle}
                    </a>
                  </td>
                  {/* 変更された項目 (HISTORY_FIELD_LABELS で日本語ラベルに変換) */}
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-slate-600">
                    {HISTORY_FIELD_LABELS[log.field as keyof typeof HISTORY_FIELD_LABELS] ?? log.field}
                  </td>
                  {/* 変更前の値 (null の場合は「−」で表示) */}
                  <td className="px-4 py-3 text-sm text-slate-500">
                    {log.oldValue ?? '−'}
                  </td>
                  {/* 変更後の値 (null の場合は「−」で表示) */}
                  <td className="px-4 py-3 text-sm text-slate-900 font-medium">
                    {log.newValue ?? '−'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
