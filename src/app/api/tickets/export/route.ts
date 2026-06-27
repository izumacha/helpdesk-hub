// セッション取得
import { auth } from '@/lib/auth';
// データ層の Composition Root (Prisma 直叩きを避ける)
import { repos } from '@/data';
// エージェント判定ヘルパー
import { isAgent as checkIsAgent } from '@/lib/role';
// レート制限 (CSV エクスポートは DB 全件取得を伴う重い操作のため §9 DoS 防止として必須)
import { enforceRateLimit, RateLimitError } from '@/lib/rate-limit';
// テナントの動作モード (lite | pro) を取得するヘルパー
import { getCurrentTenantMode } from '@/lib/tenant';
// フィルタ組み立て共有関数 (一覧ページと同一ロジックを使う)
import { buildTicketListFilter } from '@/features/tickets/build-filter';
// CSV 文字列生成ユーティリティ
import { buildCsvString } from '@/lib/csv';
// ステータス日本語ラベル (mode-aware) と優先度ラベル
import { getStatusLabel, PRIORITY_LABELS } from '@/lib/constants';
// JST 日時フォーマット
import { formatDateTimeJP, formatDateJP } from '@/lib/format-date';
// TicketWithRefs 型 (一覧取得の戻り値) と TenantMode 型 (mode-aware ラベル用)
// @/generated/prisma ではなく正準 @/domain/types から import する (lint ルール: no-restricted-imports)
import type { TicketWithRefs, TenantMode } from '@/domain/types';

// 1 リクエストで出力できるチケットの最大件数。
// 件数無制限の取得は DB 負荷・レスポンスサイズ・処理時間が無制限になるため
// 上限を設ける (§8 パフォーマンス / §9 DoS 防止)。
const MAX_EXPORT_ROWS = 10_000;

/**
 * チケット一覧 (TicketWithRefs) を CSV 文字列に変換する純粋関数。
 * mode によって日本語ラベルを切り替える。
 */
function ticketsToCsv(tickets: TicketWithRefs[], mode: TenantMode): string {
  // ヘッダー行: CSV エクスポートに含める列名を日本語で定義する
  const headers = [
    'ID',
    '件名',
    '状況',
    '優先度',
    'カテゴリ',
    '担当者',
    '起票者',
    '解決期限',
    '起票日時',
    '更新日時',
  ];

  // データ行: チケット 1 件を文字列の配列 (1 行分) に変換する
  const rows = tickets.map((t) => [
    // チケット ID (識別子として先頭に置く)
    t.id,
    // 件名 (title)
    t.title,
    // 状況: lite / pro モードに応じた日本語ラベル (getStatusLabel が一元管理)
    getStatusLabel(t.status, mode),
    // 優先度: PRIORITY_LABELS が一元管理する日本語ラベル
    PRIORITY_LABELS[t.priority] ?? t.priority,
    // カテゴリ名 (未分類なら空文字)
    t.category?.name ?? '',
    // 担当者名 (未アサインなら空文字)
    t.assignee?.name ?? '',
    // 起票者名 (まれに関連ユーザーが取れない場合を考慮してオプショナルチェーンを使う)
    t.creator?.name ?? '',
    // 解決期限: 設定されていれば JST の年月日形式、未設定なら空文字
    t.resolutionDueAt ? formatDateJP(t.resolutionDueAt) : '',
    // 起票日時: JST の年月日 時分秒形式
    formatDateTimeJP(t.createdAt),
    // 更新日時: JST の年月日 時分秒形式
    formatDateTimeJP(t.updatedAt),
  ]);

  // ヘッダー + データ行を BOM 付き CSV 文字列にして返す
  return buildCsvString(headers, rows);
}

/**
 * GET /api/tickets/export
 *
 * チケット一覧を CSV ファイルとしてダウンロードする。
 * クエリパラメータは /tickets 一覧ページと同一の絞り込み条件をそのまま受け取る。
 *
 * - 認証必須: 未認証は 401
 * - tenantId スコープ: セッションの tenantId で必ず絞り込む (クロステナント漏洩防止)
 * - 最大 MAX_EXPORT_ROWS 件の上限あり
 */
export async function GET(req: Request) {
  // セッション取得 (未認証 / tenantId 欠落は 401 を返す)
  const session = await auth();
  // 未ログイン、または tenantId が取得できない場合は 401 を返す
  // tenantId 欠落のまま進むとクロステナント漏洩になるため早期に弾く (§9 セキュリティ)
  if (!session?.user?.id || !session.user.tenantId) {
    return new Response(JSON.stringify({ error: '認証が必要です' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // セッションからユーザー情報とテナント ID を取り出す
  const userId = session.user.id;
  const tenantId = session.user.tenantId;
  // ロール判定: 担当者かどうかで RBAC フィルタが変わる
  const isAgent = checkIsAgent(session.user.role);

  // CSV エクスポートは DB 全件取得を伴う重い操作のためレート制限を適用する
  // (ユーザー単位で 60 秒あたり 5 回まで。DoS / リソース枯渇防止 §8 / §9)
  try {
    enforceRateLimit(`csv-export:${userId}`, { limit: 5, windowMs: 60_000 });
  } catch (err) {
    // 流量超過の場合のみ 429 を返す。それ以外は想定外エラーとして上位へ投げる
    if (err instanceof RateLimitError) {
      return new Response(
        JSON.stringify({ error: 'エクスポートのリクエストが多すぎます。しばらくしてから再試行してください。' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '60',
          },
        },
      );
    }
    throw err;
  }

  // URL のクエリパラメータを取り出す
  const { searchParams } = new URL(req.url);

  // フィルタを組み立てる (一覧ページと同一の buildTicketListFilter を使い二重定義を避ける)
  const filter = buildTicketListFilter(
    {
      // フリーワード検索
      q: searchParams.get('q') ?? undefined,
      // ステータス絞り込み
      status: searchParams.get('status') ?? undefined,
      // 優先度絞り込み
      priority: searchParams.get('priority') ?? undefined,
      // カテゴリ絞り込み
      categoryId: searchParams.get('categoryId') ?? undefined,
      // 担当者絞り込み
      assigneeId: searchParams.get('assigneeId') ?? undefined,
      // 拠点絞り込み
      locationId: searchParams.get('locationId') ?? undefined,
      // タブ絞り込み ('mine' / 'overdue' / 'all')
      tab: searchParams.get('tab') ?? undefined,
    },
    { isAgent, userId, now: new Date() },
  );

  // 絞り込み条件に一致するチケットを最大 MAX_EXPORT_ROWS 件取得する
  // (件数無制限の取得は DoS / リソース枯渇になるため上限を設ける §8 / §9)
  const tickets = await repos.tickets.list({
    filter,
    page: { skip: 0, take: MAX_EXPORT_ROWS },
    sort: { field: 'createdAt', direction: 'desc' },
    tenantId,
  });

  // テナントの動作モード (lite | pro) を取得して日本語ラベル切り替えに使う
  const mode = await getCurrentTenantMode(tenantId);

  // チケット一覧を CSV 文字列に変換する
  const csv = ticketsToCsv(tickets, mode);

  // ファイル名に今日の JST 日付を含める (ダウンロードフォルダで日付識別できる)
  // サーバーサイドで生成するためブラウザの日付設定に依存しない
  const today = new Date()
    .toLocaleDateString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    .replace(/\//g, '-'); // YYYY/MM/DD → YYYY-MM-DD
  const filename = `tickets-${today}.csv`;

  // CSV ファイルとしてダウンロードするレスポンスを返す
  const responseHeaders: HeadersInit = {
    // UTF-8 の CSV であることを明示する
    'Content-Type': 'text/csv; charset=utf-8',
    // ブラウザにファイルとして保存させる (attachment) + ファイル名を指定する
    // RFC 5987 の filename* は省略 (ASCII ファイル名のため不要)
    'Content-Disposition': `attachment; filename="${filename}"`,
    // キャッシュさせない (毎回最新データを取得させる)
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  };
  // 取得件数が上限に達した場合は打ち切りを呼び出し元に通知する
  // (サイレント打ち切りは監査目的で「全件取得済み」と誤認させるリスクがある)
  if (tickets.length === MAX_EXPORT_ROWS) {
    responseHeaders['X-Truncated'] = 'true';
    responseHeaders['X-Total-Limit'] = String(MAX_EXPORT_ROWS);
  }
  return new Response(csv, { status: 200, headers: responseHeaders });
}
