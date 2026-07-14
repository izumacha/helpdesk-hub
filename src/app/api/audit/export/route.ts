// 「ログイン済み・admin・自テナント」の共通ゲート (LINE/SSO 設定の認可ゲートと同じ実装を共有する。
// /code-review ultra 指摘対応: このルートだけ auth() + セッションチェックを手書きで複製していた)
import { assertTenantAdmin } from '@/lib/tenant-admin-gate';
// 監査ログ機能のプランゲート (§6.1 料金プラン: Pro / Enterprise のみ利用可能)
import { isAuditLogAllowed } from '@/lib/plan-guard';
// テナントの現在プランを解決する共通ヘルパー
import { resolveTenantPlan } from '@/lib/tenant-plan';
// レート制限 (全履歴エクスポートは複数ページを DB から読み続ける重い操作のため §9 DoS 防止として必須)
import { enforceRateLimit, RateLimitError } from '@/lib/rate-limit';
// TicketHistory + SettingsAuditLog を 1 ページ分取得してマージする共有ロジック (/audit ページと共有)
import { fetchAuditFeedPage } from '@/features/audit/fetch-audit-feed-page';
// 監査ログ系リポジトリ共通のページネーション上限 (1 回の findAllByTenant で取得できる最大件数)
import { AUDIT_MAX_LIMIT } from '@/data/adapters/audit-pagination';
// 監査ログ一覧が扱う統一行型
import type { AuditFeedRow } from '@/features/audit/types';
// キーセットページネーションのカーソル型 (ページを跨いで前進させるループで使う)
import type { AuditPaginationCursor } from '@/data/ports/audit-pagination';
// CSV 文字列への変換 (クライアント側の現在ページエクスポートと共有する純粋関数。§6 DRY)
import { auditFeedRowsToCsv } from '@/features/audit/audit-csv';
// キーセットカーソル前進ループ・CSV レスポンス組み立ての共通ヘルパー (フォローアップ 2026-07-14 #3:
// GET /api/quarantine/export と共有する。§6 DRY)
import { collectCursorPaginatedRows, buildCsvExportResponse } from '@/lib/cursor-csv-export';

// 全履歴エクスポートで書き出す行数の上限。
// 件数無制限の取得は DB 負荷・レスポンスサイズ・処理時間が無制限になるため
// 上限を設ける (§8 パフォーマンス / §9 DoS 防止。GET /api/tickets/export の
// MAX_EXPORT_ROWS と同じ考え方)。
const MAX_AUDIT_EXPORT_ROWS = 10_000;
// /code-review ultra 指摘対応: ページングループは 1 ページあたり AUDIT_MAX_LIMIT 件ずつ蓄積するため、
// MAX_AUDIT_EXPORT_ROWS が AUDIT_MAX_LIMIT の倍数でないと「上限をちょうど超えた」という前提の
// 分岐 (下記ループの `logs.length &gt; MAX_AUDIT_EXPORT_ROWS`) が意図と異なる件数で発火しうる。
// モジュール読み込み時に 1 度だけ検査して fail-fast する (audit/page.tsx の PAGE_LIMIT 検査と同じ考え方)
if (MAX_AUDIT_EXPORT_ROWS % AUDIT_MAX_LIMIT !== 0) {
  throw new Error(
    'MAX_AUDIT_EXPORT_ROWS が AUDIT_MAX_LIMIT の倍数ではありません (audit/export/route.ts の設定ミス)',
  );
}

/**
 * GET /api/audit/export
 *
 * 監査ログ (チケット変更履歴 + 設定変更監査ログ) の全履歴を CSV ファイルとしてダウンロードする。
 * /audit 画面は 1 ページ PAGE_LIMIT (200) 件までしか表示・エクスポートできず、監査目的で
 * 「さらに読み込む」を手作業で辿らないと古い行に到達できなかった (§4.2.1 フォローアップ)。
 * このエンドポイントはキーセットカーソルをサーバー側で繰り返し前進させ、上限 MAX_AUDIT_EXPORT_ROWS
 * 件までまとめて 1 つの CSV に書き出す。
 *
 * - 認証必須: 未認証は 401
 * - 管理者専用: admin 以外は 403 (画面側の RBAC と同じく role === 'admin' の直接比較。監査ログは
 *   agent には見せない意図的な設計を踏襲する)
 * - プランゲート: Pro / Enterprise のみ (画面側と同じ isAuditLogAllowed)
 * - tenantId スコープ: セッションの tenantId で必ず絞り込む (クロステナント漏洩防止)
 * - 最大 MAX_AUDIT_EXPORT_ROWS 件の上限あり
 */
export async function GET() {
  // 「ログイン済み・admin・自テナント」をまとめて検証する (画面側の /audit と同じく role の
  // 直接比較。isAgent ではなく admin 限定にする意図的な設計は assertTenantAdmin 側で担保する)
  const gate = await assertTenantAdmin();
  if (!gate.ok) {
    // 未認証 (セッション/tenantId 欠落) と権限不足を区別してステータスコードを分ける
    const status = gate.error === '認証が必要です' ? 401 : 403;
    return new Response(JSON.stringify({ error: gate.error }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const { userId, tenantId } = gate;

  // 監査ログはプランゲート対象の機能 (Pro / Enterprise のみ)。UI 非表示だけに頼らずサーバー側で強制する (§9)
  const plan = await resolveTenantPlan(tenantId);
  if (!isAuditLogAllowed(plan)) {
    return new Response(
      JSON.stringify({ error: '監査ログは Pro / Enterprise プランでご利用いただけます' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // 全履歴エクスポートは複数ページの DB 読み取りを伴う重い操作のため、通常の CSV エクスポート
  // (5 回/分) より厳しいレート制限をかける (§8 / §9 DoS 防止)
  try {
    enforceRateLimit(`audit-csv-export:${userId}`, { limit: 3, windowMs: 60_000 });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return new Response(
        JSON.stringify({
          error: 'エクスポートのリクエストが多すぎます。しばらくしてから再試行してください。',
        }),
        { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' } },
      );
    }
    throw err;
  }

  // カーソルをサーバー側で繰り返し前進させ、上限まで全ページを蓄積する。
  // 1 ページあたり AUDIT_MAX_LIMIT (500) 件ずつ取得することで往復回数を最小化する。
  // フォローアップ (2026-07-14 #3 /code-review ultra 指摘対応): GET /api/quarantine/export が
  // 同じループ・打ち切り誤検知防止ロジックを必要としたため、共通ヘルパーへ抽出した (§6 DRY)
  const { rows: logs, truncated } = await collectCursorPaginatedRows<
    AuditFeedRow,
    AuditPaginationCursor
  >({
    maxRows: MAX_AUDIT_EXPORT_ROWS,
    fetchPage: async (cursor) => {
      const page = await fetchAuditFeedPage(tenantId, AUDIT_MAX_LIMIT, cursor);
      return { rows: page.logs, hasMore: page.hasMore, nextCursor: page.nextCursor };
    },
    // ちょうど上限に到達したときだけ、次カーソル以降に本当に行が残っているかを 1 件だけ
    // 確認する (「ちょうど limit 件で埋まった」だけのヒューリスティックだと、テナントの総件数が
    // たまたま MAX_AUDIT_EXPORT_ROWS ちょうどだった場合に「まだ続きがある」という誤検知になりうる)
    probeForMore: async (nextCursor) =>
      (await fetchAuditFeedPage(tenantId, 1, nextCursor)).logs.length > 0,
  });

  // 監査ログ行の一覧を CSV 文字列に変換する (クライアント側ボタンと共有する純粋関数)
  const csv = auditFeedRowsToCsv(logs);

  // CSV レスポンスを組み立てて返す (ファイル名の JST 日付付与・打ち切り時のヘッダーを含む)
  return buildCsvExportResponse({
    csv,
    filenamePrefix: 'audit-log-full',
    truncated,
    maxRows: MAX_AUDIT_EXPORT_ROWS,
  });
}
