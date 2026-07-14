// 現在のセッション取得
import { auth } from '@/lib/auth';
// 認証エラー時のリダイレクト
import { redirect } from 'next/navigation';
// リポジトリ束 (隔離記録の取得に使用)
import { repos } from '@/data';
// 日付フォーマットヘルパー (年月日時分秒を JST で表示する)
import { formatDateTimeJP } from '@/lib/format-date';
// 隔離理由・チャネルの日本語ラベル
import { QUARANTINE_REASON_LABELS, QUARANTINE_CHANNEL_LABELS } from '@/lib/constants';
// 監査ログ系リポジトリ共通のページネーション上限 (findAllByTenant が limit をクランプする上限値)
import { AUDIT_MAX_LIMIT } from '@/data/adapters/audit-pagination';
// 全履歴 CSV エクスポートボタン (Client Component。フォローアップ 2026-07-14 #3)
import { QuarantineExportButton } from '@/features/quarantine/components/QuarantineExportButton';

// 一覧の取得件数上限 (パフォーマンス保護: 1 ページあたり 200 件まで。/audit と同じ値)
const PAGE_LIMIT = 200;
if (PAGE_LIMIT > AUDIT_MAX_LIMIT) {
  throw new Error('PAGE_LIMIT が AUDIT_MAX_LIMIT を超えています (quarantine/page.tsx の設定ミス)');
}

// ページ Props (Next.js 15 の Route Group ページは searchParams を Promise で受け取る)
interface Props {
  searchParams: Promise<{
    // 「さらに読み込む」用のキーセットページネーションカーソル (/audit と同じ設計。
    // ただしこの一覧は単一テーブルのみを表示するため kind を持たない)
    before?: string;
    beforeId?: string;
  }>;
}

// 隔離メール/LINE メッセージ一覧ページ (管理者専用)
// docs/smb-dx-pivot-plan.md §3.2 フォローアップ: 未登録送信者・プラン未対応・認証失敗等で
// 起票されなかった受信メールを admin が確認できる一覧を提供する。
// フォローアップ (2026-07-13): 監査で発見したギャップの解消。LINE 取り込みも同じ「console.warn の
// サーバーログにしか残らず admin から確認できない」不備を抱えていたため、この一覧に LINE 由来の
// 隔離記録 (経路列で判別) も表示するようにした。
export default async function QuarantinePage({ searchParams }: Props) {
  const sp = await searchParams;
  // before/beforeId は URL から来る外部入力なので、不正な値でも落ちないよう検証する
  // (§9 入力検証: 壊れたデータでクラッシュさせずフォールバックする)
  const parsedBefore = sp.before ? new Date(sp.before) : null;
  const before =
    parsedBefore && !isNaN(parsedBefore.getTime()) && sp.beforeId
      ? { createdAt: parsedBefore, id: sp.beforeId }
      : undefined;

  // セッション取得 (middleware で未ログインは弾かれている前提)
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) redirect('/login');

  // 管理者以外は権限なし表示を返す (/audit と同じ role === 'admin' 直接比較の RBAC)
  if (session.user.role !== 'admin') {
    return (
      <div className="rounded-2xl bg-white py-20 text-center text-slate-400 ring-1 ring-slate-200">
        <p className="text-sm">この画面は管理者のみ利用できます。</p>
      </div>
    );
  }

  // テナント全体の隔離記録を取得する (上限 PAGE_LIMIT 件)。
  // プランゲートは設けない: Free プランでの隔離 (plan_gate 理由) を admin 自身が確認できることは
  // 「なぜメールが取り込まれないか」に気づく導線として有用なため、全プランで閲覧できるようにする。
  const logs = await repos.quarantinedEmails.findAllByTenant({
    tenantId: session.user.tenantId,
    limit: PAGE_LIMIT,
    before,
  });

  // このページがちょうど PAGE_LIMIT 件で埋まっていれば、まだ表示していない古い行が残っている
  // 可能性があるとみなす (/audit と同じ簡易ヒューリスティック)
  const hasMore = logs.length === PAGE_LIMIT;
  const oldestLog = hasMore ? logs[logs.length - 1] : null;

  return (
    <div className="space-y-6">
      {/* ページヘッダー */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">隔離メール</h1>
          <p className="mt-1 text-sm text-slate-500">
            プラン未対応・未登録の送信者・認証失敗などで問い合わせ化されなかったメール/LINE
            メッセージを表示しています。
            {before ? `${PAGE_LIMIT} 件ずつ表示中。` : `最新 ${PAGE_LIMIT} 件。`}
          </p>
        </div>
        {/* フォローアップ (2026-07-14 #3): 監査で発見したギャップの解消。「さらに読み込む」を
            手動で辿らないと 200 件を超える隔離記録に到達できず、まとめて保管・共有する手段も
            無かった (/audit 画面が §4.2.1/§4.2.2 で解消したのと同種のギャップ) */}
        <div className="shrink-0">
          <QuarantineExportButton />
        </div>
      </div>

      {logs.length === 0 ? (
        <div className="rounded-2xl bg-white py-20 text-center text-slate-400 ring-1 ring-slate-200">
          <p className="text-sm">隔離された記録はありません。</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-slate-100">
          <table className="min-w-full divide-y divide-slate-200" aria-label="隔離記録の一覧">
            <thead className="bg-slate-50">
              <tr>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-semibold tracking-wider text-slate-500 uppercase"
                >
                  日時
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-semibold tracking-wider text-slate-500 uppercase"
                >
                  経路
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-semibold tracking-wider text-slate-500 uppercase"
                >
                  送信者
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-semibold tracking-wider text-slate-500 uppercase"
                >
                  件名
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-semibold tracking-wider text-slate-500 uppercase"
                >
                  理由
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {logs.map((log) => (
                <tr key={log.id} className="transition-colors hover:bg-slate-50/60">
                  <td className="px-4 py-3 text-sm whitespace-nowrap text-slate-500">
                    <time dateTime={log.createdAt.toISOString()}>
                      {formatDateTimeJP(log.createdAt)}
                    </time>
                  </td>
                  <td className="px-4 py-3 text-sm whitespace-nowrap text-slate-600">
                    {QUARANTINE_CHANNEL_LABELS[log.channel]}
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-700">
                    {/* フォローアップ (2026-07-13): channel によって送信者の表現が異なる
                        (メールは senderName/senderAddress、LINE は lineUserId) */}
                    {log.channel === 'email' ? (
                      <>
                        {/* 送信者名が取れなかった場合 (null) はアドレスのみでも意味が通るよう
                            フォールバック文言を表示する (/code-review ultra 指摘対応) */}
                        <div className="font-medium text-slate-900">
                          {log.senderName ?? '(送信者名なし)'}
                        </div>
                        {/* /code-review ultra 指摘対応 (2026-07-13): senderName/subject と同じく
                            null を安全に表示するフォールバックを付ける (RecordQuarantinedEmailInput
                            は channel='email' で常に非 null を要求するが、表示側は DB 由来の値を
                            そのまま信用せず念のため備える) */}
                        <div className="text-xs text-slate-500">
                          {log.senderAddress ?? '(送信元アドレスなし)'}
                        </div>
                      </>
                    ) : (
                      <div className="font-medium text-slate-900">
                        LINE ユーザー ID: {log.lineUserId ?? '(不明)'}
                      </div>
                    )}
                  </td>
                  <td className="max-w-xs px-4 py-3 text-sm text-slate-700">
                    <span className="line-clamp-1">{log.subject ?? '(件名なし)'}</span>
                  </td>
                  <td className="px-4 py-3 text-sm whitespace-nowrap text-slate-600">
                    {QUARANTINE_REASON_LABELS[log.reason]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && oldestLog && (
        <div className="text-center">
          <a
            href={`/quarantine?before=${encodeURIComponent(oldestLog.createdAt.toISOString())}&beforeId=${encodeURIComponent(oldestLog.id)}`}
            className="inline-block rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-teal-200 hover:text-teal-800"
          >
            さらに読み込む（{formatDateTimeJP(oldestLog.createdAt)} より前）
          </a>
        </div>
      )}
    </div>
  );
}
