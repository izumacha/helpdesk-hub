// 「ログイン済み・admin・自テナント」の共通ゲート (/api/audit/export と同じ実装を共有する)
import { assertTenantAdmin } from '@/lib/tenant-admin-gate';
// レート制限 (全履歴エクスポートは複数ページを DB から読み続ける重い操作のため §9 DoS 防止として必須)
import { enforceRateLimit, RateLimitError } from '@/lib/rate-limit';
// データ層の Composition Root (Prisma 直叩きを避ける)
import { repos } from '@/data';
// 隔離記録一覧が扱う行型・キーセットページネーションのカーソル型
import type { QuarantinedEmailCursor } from '@/data/ports/quarantined-email-repository';
import type { QuarantinedEmailRow } from '@/domain/types';
// 監査ログ系リポジトリ共通のページネーション上限 (findAllByTenant が limit をクランプする上限値。
// quarantinedEmails.findAllByTenant も resolveAuditLimit 経由でこの値を共有する)
import { AUDIT_MAX_LIMIT } from '@/data/adapters/audit-pagination';
// CSV 文字列への変換 (/quarantine ページの将来的な現在ページエクスポートとも共有できる純粋関数。§6 DRY)
import { quarantinedEmailRowsToCsv } from '@/features/quarantine/quarantine-csv';

// 全履歴エクスポートで書き出す行数の上限。
// 件数無制限の取得は DB 負荷・レスポンスサイズ・処理時間が無制限になるため
// 上限を設ける (§8 パフォーマンス / §9 DoS 防止。GET /api/audit/export の
// MAX_AUDIT_EXPORT_ROWS と同じ考え方)。
const MAX_QUARANTINE_EXPORT_ROWS = 10_000;
// /code-review ultra 指摘対応 (audit/export/route.ts と同じ検査): ページングループは 1 ページ
// あたり AUDIT_MAX_LIMIT 件ずつ蓄積するため、MAX_QUARANTINE_EXPORT_ROWS が AUDIT_MAX_LIMIT の
// 倍数でないと「上限をちょうど超えた」という前提の分岐が意図と異なる件数で発火しうる。
// モジュール読み込み時に 1 度だけ検査して fail-fast する
if (MAX_QUARANTINE_EXPORT_ROWS % AUDIT_MAX_LIMIT !== 0) {
  throw new Error(
    'MAX_QUARANTINE_EXPORT_ROWS が AUDIT_MAX_LIMIT の倍数ではありません (quarantine/export/route.ts の設定ミス)',
  );
}

/**
 * GET /api/quarantine/export
 *
 * 隔離記録 (メール取り込み・LINE 取り込みが起票せず隔離した受信データ) の全履歴を CSV
 * ファイルとしてダウンロードする。/quarantine 画面は 1 ページ PAGE_LIMIT (200) 件までしか
 * 表示できず、CSV エクスポート自体を持たないため、200 件を超えるテナントでは「さらに読み込む」を
 * 手作業で辿らないと古い行に到達できず、まとめて保管・共有する手段も無かった
 * (フォローアップ 2026-07-14 #3: /audit 画面が §4.2.1/§4.2.2 で解消したのと同種のギャップ)。
 * このエンドポイントはキーセットカーソルをサーバー側で繰り返し前進させ、上限
 * MAX_QUARANTINE_EXPORT_ROWS 件までまとめて 1 つの CSV に書き出す。
 *
 * - 認証必須: 未認証は 401
 * - 管理者専用: admin 以外は 403 (画面側の RBAC と同じく role === 'admin' の直接比較)
 * - プランゲートなし: /quarantine 画面と同じく全プランで利用可能（Free プランでの隔離
 *   (plan_gate 理由) を admin 自身が確認できることが「なぜ取り込まれないか」に気づく導線として
 *   有用なため。§3.2 フォローアップ再訪の方針を踏襲する）
 * - tenantId スコープ: セッションの tenantId で必ず絞り込む (クロステナント漏洩防止)
 * - 最大 MAX_QUARANTINE_EXPORT_ROWS 件の上限あり
 */
export async function GET() {
  // 「ログイン済み・admin・自テナント」をまとめて検証する (画面側の /quarantine と同じく
  // role の直接比較。プランゲートは行わない)
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

  // 全履歴エクスポートは複数ページの DB 読み取りを伴う重い操作のため、通常の CSV エクスポート
  // より厳しいレート制限をかける (§8 / §9 DoS 防止。/api/audit/export と同じ値)
  try {
    enforceRateLimit(`quarantine-csv-export:${userId}`, { limit: 3, windowMs: 60_000 });
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
  // 1 ページあたり AUDIT_MAX_LIMIT 件ずつ取得することで往復回数を最小化する
  // (/api/audit/export と同じループ構造。ただしこの一覧は単一テーブルのみで kind を持たない
  // ため、fetchAuditFeedPage のような複数ソースのマージ処理は不要で repos を直接呼ぶ)。
  const logs: QuarantinedEmailRow[] = [];
  let cursor: QuarantinedEmailCursor | undefined = undefined;
  let truncated = false;
  for (;;) {
    const page = await repos.quarantinedEmails.findAllByTenant({
      tenantId,
      limit: AUDIT_MAX_LIMIT,
      before: cursor,
    });
    logs.push(...page);
    // 上限に達したら、まだ続きがあっても打ち切る (サイレント打ち切りは監査目的で
    // 「全件取得済み」と誤認させるリスクがあるため X-Truncated ヘッダーで呼び出し元に伝える)。
    // MAX_QUARANTINE_EXPORT_ROWS は AUDIT_MAX_LIMIT の倍数であること (上のモジュール読み込み時
    // 検査) が保証されているため logs.length はここで必ずちょうど MAX_QUARANTINE_EXPORT_ROWS に
    // 一致し、超過はしない
    if (logs.length >= MAX_QUARANTINE_EXPORT_ROWS) {
      // ちょうど上限に到達したときだけ、次カーソル以降に本当に行が残っているかを 1 件だけ
      // 確認してから truncated を確定する (/api/audit/export と同じ「誤って打ち切りを警告しない」方針)
      const last = page[page.length - 1];
      truncated =
        page.length === AUDIT_MAX_LIMIT && last
          ? (
              await repos.quarantinedEmails.findAllByTenant({
                tenantId,
                limit: 1,
                before: { createdAt: last.createdAt, id: last.id },
              })
            ).length > 0
          : false;
      break;
    }
    // ページがちょうど上限件数で埋まっていなければ、これ以上データは残っていない
    if (page.length < AUDIT_MAX_LIMIT) break;
    const last = page[page.length - 1];
    if (!last) break;
    cursor = { createdAt: last.createdAt, id: last.id };
  }

  // 隔離記録の一覧を CSV 文字列に変換する
  const csv = quarantinedEmailRowsToCsv(logs);

  // ファイル名に今日の JST 日付を含める (ダウンロードフォルダで日付識別できる)
  const today = new Date()
    .toLocaleDateString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    .replace(/\//g, '-'); // YYYY/MM/DD → YYYY-MM-DD
  const filename = `quarantine-full-${today}.csv`;

  const responseHeaders: HeadersInit = {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  };
  if (truncated) {
    responseHeaders['X-Truncated'] = 'true';
    responseHeaders['X-Total-Limit'] = String(MAX_QUARANTINE_EXPORT_ROWS);
  }
  return new Response(csv, { status: 200, headers: responseHeaders });
}
