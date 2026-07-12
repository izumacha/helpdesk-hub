// セッション取得
import { auth } from '@/lib/auth';
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

// 全履歴エクスポートで書き出す行数の上限。
// 件数無制限の取得は DB 負荷・レスポンスサイズ・処理時間が無制限になるため
// 上限を設ける (§8 パフォーマンス / §9 DoS 防止。GET /api/tickets/export の
// MAX_EXPORT_ROWS と同じ考え方)。
const MAX_AUDIT_EXPORT_ROWS = 10_000;

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
  // セッション取得 (未認証は 401)
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) {
    return new Response(JSON.stringify({ error: '認証が必要です' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const userId = session.user.id;
  const tenantId = session.user.tenantId;

  // 監査ログ画面と同じく admin 限定 (isAgent ではなく role の直接比較。意図的な設計)
  if (session.user.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'この操作には管理者権限が必要です' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

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
  const logs: AuditFeedRow[] = [];
  let cursor: AuditPaginationCursor | undefined = undefined;
  let truncated = false;
  for (;;) {
    const page = await fetchAuditFeedPage(tenantId, AUDIT_MAX_LIMIT, cursor);
    logs.push(...page.logs);
    // 上限に達したら、まだ続きがあっても打ち切る (サイレント打ち切りは監査目的で
    // 「全件取得済み」と誤認させるリスクがあるため X-Truncated ヘッダーで呼び出し元に伝える)
    if (logs.length >= MAX_AUDIT_EXPORT_ROWS) {
      truncated = page.hasMore || logs.length > MAX_AUDIT_EXPORT_ROWS;
      logs.length = MAX_AUDIT_EXPORT_ROWS;
      break;
    }
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }

  // 監査ログ行の一覧を CSV 文字列に変換する (クライアント側ボタンと共有する純粋関数)
  const csv = auditFeedRowsToCsv(logs);

  // ファイル名に今日の JST 日付を含める (ダウンロードフォルダで日付識別できる)
  const today = new Date()
    .toLocaleDateString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    .replace(/\//g, '-'); // YYYY/MM/DD → YYYY-MM-DD
  const filename = `audit-log-full-${today}.csv`;

  const responseHeaders: HeadersInit = {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  };
  if (truncated) {
    responseHeaders['X-Truncated'] = 'true';
    responseHeaders['X-Total-Limit'] = String(MAX_AUDIT_EXPORT_ROWS);
  }
  return new Response(csv, { status: 200, headers: responseHeaders });
}
