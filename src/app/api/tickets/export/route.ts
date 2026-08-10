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
// JST 日時フォーマット。formatDateTimeISO は「起票日時」列専用 (機械可読・再インポート対応。
// フォローアップ 2026-07-15 #3)、formatDateTimeJP は「更新日時」列専用 (表示のみ・再インポート非対応)
import { formatDateTimeJP, formatDateTimeISO, formatDateISO } from '@/lib/format-date';
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
  // フォローアップ (2026-07-11): 「内容」列がエクスポートに無く、CSV インポート (「内容」列に
  // 対応済み) との往復ができなかった不備を解消するため、「件名」の直後に追加する
  // (CsvImportForm.tsx の SYSTEM_FIELDS と同じ列順に揃える)
  // フォローアップ (2026-07-11 #2): 期限日列は従来「解決期限」という別名だったため、CSV インポート
  // 側が既に使っている列名「期限日」に統一した (import-tickets.ts の headers.indexOf('期限日') /
  // CsvImportForm.tsx の SYSTEM_FIELDS と同じ列名に揃える。詳細は下記データ行の値のコメント参照)
  const headers = [
    'ID',
    '件名',
    '内容',
    '状況',
    '優先度',
    'カテゴリ',
    '拠点',
    '担当者',
    '起票者',
    '期限日',
    '起票日時',
    '更新日時',
  ];

  // データ行: チケット 1 件を文字列の配列 (1 行分) に変換する
  const rows = tickets.map((t) => [
    // チケット ID (識別子として先頭に置く)
    t.id,
    // 件名 (title)
    t.title,
    // 内容 (body): CSV インジェクション対策は buildCsvString 側の escapeCSVCell で行う (§9)
    t.body,
    // 状況: lite / pro モードに応じた日本語ラベル (getStatusLabel が一元管理)
    getStatusLabel(t.status, mode),
    // 優先度: PRIORITY_LABELS が一元管理する日本語ラベル
    PRIORITY_LABELS[t.priority] ?? t.priority,
    // カテゴリ名 (未分類なら空文字)
    t.category?.name ?? '',
    // 拠点名 (Phase 4 多拠点。未指定なら空文字)
    t.location?.name ?? '',
    // 担当者名 (未アサインなら空文字)
    t.assignee?.name ?? '',
    // 起票者名 (まれに関連ユーザーが取れない場合を考慮してオプショナルチェーンを使う)
    t.creator?.name ?? '',
    // 期限日 (解決期限): 設定されていれば JST の 'YYYY-MM-DD' 形式、未設定なら空文字。
    // フォローアップ (2026-07-11 #2): 従来は formatDateJP (ja-JP ロケール、例 '2026/3/31'。
    // 非ゼロ埋め) で出力しており、CSV インポートの parseDateLocal が要求する
    // 'YYYY-MM-DD' 厳密形式と一致せず再インポートできなかった。formatDateISO に変更し、
    // エクスポートした CSV をそのまま (列名・書式とも) 再インポートできるようにする。
    t.resolutionDueAt ? formatDateISO(t.resolutionDueAt) : '',
    // 起票日時: JST の 'YYYY-MM-DD HH:mm:ss' 形式 (ゼロ埋め済み・再パース可能)。
    // フォローアップ (2026-07-15 #3): 以前は formatDateTimeJP (ja-JP ロケール、例 '2026/7/15 9:30:00'。
    // 非ゼロ埋め) で出力しており、期限日と同じ理由でそのまま再インポートできなかった。
    // CSV インポートが対応する formatDateTimeISO に変更し、既存 Excel 台帳の移行時に元の起票日時を
    // 保持したまま再インポートできるようにする (往復性。§0 北極星指標)
    formatDateTimeISO(t.createdAt),
    // 更新日時: 再インポート対象ではない表示専用列のため、従来どおり人間可読な JST 表記を維持する
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

  // 現在時刻を一度だけ生成する。
  // フィルタ組み立て (overdue 判定) とファイル名の日付 (JST) の両方に使い回す。
  // 2 回 new Date() すると真夜中をまたいだ瞬間に日付が食い違うリスクを排除する。
  const now = new Date();

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
    // overdue タブの期限判定に now を渡す (上で一度だけ生成した値を使い回す)
    { isAgent, userId, now },
  );

  // チケット一覧取得とテナントモード取得は互いに依存しないため並列実行する
  // (§8 パフォーマンス: 直列では 2 往復かかるところを 1 往復で完了する)
  const [tickets, mode] = await Promise.all([
    // 絞り込み条件に一致するチケットを最大 MAX_EXPORT_ROWS 件取得する
    // (件数無制限の取得は DoS / リソース枯渇になるため上限を設ける §8 / §9)
    repos.tickets.list({
      filter,
      page: { skip: 0, take: MAX_EXPORT_ROWS },
      sort: { field: 'createdAt', direction: 'desc' },
      tenantId,
    }),
    // テナントの動作モード (lite | pro) を取得して日本語ラベル切り替えに使う
    getCurrentTenantMode(tenantId),
  ]);

  // チケット一覧を CSV 文字列に変換する
  const csv = ticketsToCsv(tickets, mode);

  // ファイル名に今日の JST 日付を含める (ダウンロードフォルダで日付識別できる)
  // サーバーサイドで生成するためブラウザの日付設定に依存しない。
  // 上で一度だけ生成した now を再利用してリクエスト内の日付を一貫させる。
  const today = now
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
