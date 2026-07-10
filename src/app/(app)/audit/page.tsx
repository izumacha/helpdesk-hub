// 現在のセッション取得
import { auth } from '@/lib/auth';
// 認証エラー時のリダイレクト
import { redirect } from 'next/navigation';
// リポジトリ束 (監査ログ取得に使用)
import { repos } from '@/data';
// 日付フォーマットヘルパー (年月日時分秒を JST で表示する)
import { formatDateTimeJP } from '@/lib/format-date';
// 履歴フィールド / 設定変更アクションの日本語ラベル
import { HISTORY_FIELD_LABELS, SETTINGS_AUDIT_ACTION_LABELS } from '@/lib/constants';
// CSV エクスポートボタン (Client Component)
import { AuditExportButton } from '@/features/audit/components/AuditExportButton';
// 監査ログ機能のプランゲート (§6.1 料金プラン: Pro / Enterprise のみ利用可能)
import { isAuditLogAllowed } from '@/lib/plan-guard';
// テナントの現在プランを解決する共通ヘルパー (複数箇所での重複を避ける)
import { resolveTenantPlan } from '@/lib/tenant-plan';
// 監査ログ一覧が扱う統一行型 (チケット変更履歴 + 設定変更監査ログ)
import type { AuditFeedRow } from '@/features/audit/types';

// 一覧の取得件数上限 (パフォーマンス保護: 1 ページあたり 200 件まで)
const PAGE_LIMIT = 200;

// ページ Props (Next.js 15 の Route Group ページは searchParams を Promise で受け取る)
interface Props {
  searchParams: Promise<{
    // §4.2.1 フォローアップ (2026-07-10): 「さらに読み込む」用のキーセットページネーション
    // カーソル (ISO 8601 の日時文字列)。この日時より前の行だけを表示する
    before?: string;
  }>;
}

// 監査ログページ (管理者専用)
// テナント全体のチケット変更履歴を一覧表示する。Phase 4「監査ログ / バックアップ自動化」に対応。
export default async function AuditPage({ searchParams }: Props) {
  // searchParams は Promise なので await して取り出す
  const sp = await searchParams;
  // /code-review ultra 指摘対応 (2026-07-10, §4.2.1): before は URL から来る外部入力なので、
  // 不正な文字列 (壊れた日付・過去に無効化されたリンク等) が来ても落ちないよう検証する
  // (§9 入力検証: 壊れたデータでクラッシュさせずフォールバックする)。
  // 不正なら「カーソル無し (最新から表示)」に安全側でフォールバックする
  const parsedBefore = sp.before ? new Date(sp.before) : null;
  const before = parsedBefore && !isNaN(parsedBefore.getTime()) ? parsedBefore : undefined;

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
          監査ログは Pro / Enterprise
          プランでご利用いただけます。設定画面からプランをアップグレードしてください。
        </p>
      </div>
    );
  }

  // テナント全体の変更履歴を並列取得する (上限 PAGE_LIMIT 件ずつ)。
  // §4.2 フォローアップ: チケット変更履歴だけでなく設定変更 (SSO/LINE/通知チャネル) も
  // 同じ監査ログ画面に統合する (セッション由来の tenantId のみ使用してクロステナント漏洩防止)。
  // §4.2.1 フォローアップ (2026-07-10): before をキーセットカーソルとして両方に渡す。
  // 2 種類の時系列をマージ表示する都合上、offset だけでは正しくページ送りできないため
  // (findAllByTenant のコメント参照)、双方に同じ createdAt 境界を渡す方式に統一している
  const [ticketHistory, settingsAudit] = await Promise.all([
    repos.history.findAllByTenant({ tenantId: session.user.tenantId, limit: PAGE_LIMIT, before }),
    repos.settingsAudit.findAllByTenant({
      tenantId: session.user.tenantId,
      limit: PAGE_LIMIT,
      before,
    }),
  ]);

  // 両者を共通の行型 (AuditFeedRow) に変換してマージし、新しい順に並べて PAGE_LIMIT 件に絞る
  const logs: AuditFeedRow[] = [
    ...ticketHistory.map(
      (h): AuditFeedRow => ({
        kind: 'ticket',
        id: h.id,
        createdAt: h.createdAt,
        actorName: h.changedByName,
        ticketId: h.ticketId,
        ticketTitle: h.ticketTitle,
        field: h.field,
        oldValue: h.oldValue,
        newValue: h.newValue,
      }),
    ),
    ...settingsAudit.map(
      (s): AuditFeedRow => ({
        kind: 'settings',
        id: s.id,
        createdAt: s.createdAt,
        actorName: s.actorName,
        action: s.action,
      }),
    ),
  ]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, PAGE_LIMIT);

  // §4.2.1 フォローアップ (2026-07-10): このページがちょうど PAGE_LIMIT 件で埋まっていれば、
  // まだ表示していない古い行が残っている可能性があるとみなす (簡易ヒューリスティック。
  // ちょうど境界と一致するとリンクが 1 回余分に出るだけで実害は無い)。
  const hasMore = logs.length === PAGE_LIMIT;
  // 「さらに読み込む」リンクの次カーソル = このページで最も古い行の日時
  const nextCursor = hasMore ? logs[logs.length - 1]?.createdAt : null;

  return (
    <div className="space-y-6">
      {/* ページヘッダー */}
      <div className="flex items-start justify-between gap-4">
        <div>
          {/* ページタイトル */}
          <h1 className="text-2xl font-bold text-slate-900">監査ログ</h1>
          {/* 説明文: 何が表示されているかを伝える。カーソル無し (1 ページ目) かどうかで文言を変える */}
          <p className="mt-1 text-sm text-slate-500">
            組織内のチケット変更履歴・設定変更を表示しています。
            {before ? `${PAGE_LIMIT} 件ずつ表示中。` : `最新 ${PAGE_LIMIT} 件。`}
          </p>
        </div>
        {/* CSV エクスポートボタン (Client Component)。現在表示中のページ分のみをエクスポートする
            (全履歴の一括エクスポートは対象外。件数が多いテナントは「さらに読み込む」で
            必要な期間まで辿ってからエクスポートする運用を想定) */}
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
                  担当者
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-semibold tracking-wider text-slate-500 uppercase"
                >
                  問い合わせ
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-semibold tracking-wider text-slate-500 uppercase"
                >
                  項目
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-semibold tracking-wider text-slate-500 uppercase"
                >
                  変更前
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-semibold tracking-wider text-slate-500 uppercase"
                >
                  変更後
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {logs.map((log) => (
                <tr key={log.id} className="transition-colors hover:bg-slate-50/60">
                  {/* 変更日時 (フォーマット済み) */}
                  <td className="px-4 py-3 text-sm whitespace-nowrap text-slate-500">
                    <time dateTime={log.createdAt.toISOString()}>
                      {formatDateTimeJP(log.createdAt)}
                    </time>
                  </td>
                  {/* 変更を行ったユーザー名 */}
                  <td className="px-4 py-3 text-sm font-medium text-slate-900">{log.actorName}</td>
                  {log.kind === 'ticket' ? (
                    <>
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
                      <td className="px-4 py-3 text-sm whitespace-nowrap text-slate-600">
                        {HISTORY_FIELD_LABELS[log.field as keyof typeof HISTORY_FIELD_LABELS] ??
                          log.field}
                      </td>
                      {/* 変更前の値 (null の場合は「−」で表示) */}
                      <td className="px-4 py-3 text-sm text-slate-500">{log.oldValue ?? '−'}</td>
                      {/* 変更後の値 (null の場合は「−」で表示) */}
                      <td className="px-4 py-3 text-sm font-medium text-slate-900">
                        {log.newValue ?? '−'}
                      </td>
                    </>
                  ) : (
                    <>
                      {/* 設定変更は対象チケットを持たないため「−」で表示する */}
                      <td className="px-4 py-3 text-sm text-slate-400">−</td>
                      {/* 変更された設定の種類 (SETTINGS_AUDIT_ACTION_LABELS で日本語ラベルに変換)。
                          値そのもの (channelSecret 等の秘匿情報) は記録していないため変更前/変更後は表示しない */}
                      <td className="px-4 py-3 text-sm whitespace-nowrap text-slate-600">
                        {SETTINGS_AUDIT_ACTION_LABELS[log.action] ?? log.action}
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-400">−</td>
                      <td className="px-4 py-3 text-sm text-slate-400">−</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* §4.2.1 フォローアップ (2026-07-10): PAGE_LIMIT で切り詰められた古い行 (SSO 証明書変更・
          テナントモード変更など監査上重要な設定変更を含む) に、以前は画面からもエクスポートからも
          一切到達できなかった。「さらに読み込む」でキーセットカーソルを進め、過去の行まで辿れるようにする */}
      {hasMore && nextCursor && (
        <div className="text-center">
          <a
            href={`/audit?before=${encodeURIComponent(nextCursor.toISOString())}`}
            className="inline-block rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-teal-200 hover:text-teal-800"
          >
            さらに読み込む（{formatDateTimeJP(nextCursor)} より前）
          </a>
        </div>
      )}
    </div>
  );
}
