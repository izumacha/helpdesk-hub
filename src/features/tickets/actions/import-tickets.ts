'use server';

// CSV テキストからチケットを一括作成するサーバーアクション (Phase 3 CSVインポート)
// docs/smb-dx-pivot-plan.md §4 Phase 3「CSV インポート」に対応

// セッション取得
import { auth } from '@/lib/auth';
// リポジトリ束 (チケット作成用)
import { repos } from '@/data';
// エージェント権限判定 (agent または admin のとき true)
import { isAgent } from '@/lib/role';
// 連打防止のための共通レート制限ヘルパー (超過時は RateLimitError を throw)
import { enforceRateLimit } from '@/lib/rate-limit';
// テナントの動作モード (lite | pro) を取得するヘルパー
import { getCurrentTenantMode } from '@/lib/tenant';
// 優先度・ステータスのドメイン型
import type { Priority, TicketStatus } from '@/domain/types';

// 1 インポートあたりの最大行数 (これを超えたらエラー)
const MAX_ROWS = 200;

// CSV の優先度文字列 (日本語) を Priority 型にマップする対応表
// 一元管理することで「高」「中」「低」の定義が 1 か所に集まる
const PRIORITY_MAP: Record<string, Priority> = {
  高: 'High', // 「高」→ High
  中: 'Medium', // 「中」→ Medium
  低: 'Low', // 「低」→ Low
};

// importTickets の戻り値型
export interface ImportTicketsResult {
  imported: number; // 正常に取り込めた件数
  errors: Array<{ row: number; message: string }>; // 失敗した行の番号とエラーメッセージ
}

// CSV テキストを受け取ってチケットを一括作成するサーバーアクション
export async function importTickets(csvText: string): Promise<ImportTicketsResult> {
  // セッション取得 (ログイン状態を確認)
  const session = await auth();
  // 未ログインまたは tenantId 欠落は拒否する (後段の where 句で tenantId が必須なため)
  if (!session?.user?.id || !session.user.tenantId) {
    throw new Error('認証が必要です');
  }
  // エージェント / 管理者のみ実行可能 (依頼者はアクセス不可)
  if (!isAgent(session.user.role)) {
    throw new Error('この操作はエージェントまたは管理者のみ実行できます');
  }
  // セッションから tenantId と起票者 ID を取り出す
  const tenantId = session.user.tenantId;
  const creatorId = session.user.id;

  // 60 秒あたり 5 回までに制限 (大量インポートの連打を防ぐ)
  enforceRateLimit(`csv-import:${session.user.id}`, { limit: 5, windowMs: 60_000 });

  // テナントの動作モードを取得する (初期ステータスを Lite/Pro で切り替えるために必要)
  const mode = await getCurrentTenantMode(tenantId);

  // Lite モードの初期ステータスは「Open」(未対応)、Pro モードは「New」(新規)
  const initialStatus: TicketStatus = mode === 'lite' ? 'Open' : 'New';

  // --- CSV パース開始 ---
  // 改行コード (CRLF / LF どちらにも対応) で行に分割する
  const allLines = csvText.split(/\r?\n/);
  // 空行を除外した行の配列を作る
  const nonEmptyLines = allLines.filter((line) => line.trim() !== '');

  // 1 行もない場合はエラー
  if (nonEmptyLines.length === 0) {
    throw new Error('CSV が空です');
  }

  // 1 行目をヘッダとして取り出す
  const headerLine = nonEmptyLines[0];
  // カンマで分割してヘッダ列名の配列を得る (前後の空白と引用符を除去)
  const headers = headerLine.split(',').map((h) => h.trim().replace(/^"|"$/g, ''));

  // 「件名」列が必須。見つからなければ即エラー
  const titleIndex = headers.indexOf('件名');
  if (titleIndex === -1) {
    throw new Error('CSV のヘッダに「件名」列が必要です');
  }
  // 任意列のインデックスを取得する (見つからなければ -1)
  const bodyIndex = headers.indexOf('内容'); // チケット本文
  const dueDateIndex = headers.indexOf('期限日'); // 解決期限 (YYYY-MM-DD 形式)
  const priorityIndex = headers.indexOf('優先度'); // 高 / 中 / 低

  // データ行 (2 行目以降) を取り出す
  const dataLines = nonEmptyLines.slice(1);

  // 最大行数チェック (DoS / リソース枯渇防止)
  if (dataLines.length > MAX_ROWS) {
    throw new Error(`1 回のインポートは最大 ${MAX_ROWS} 行です（${dataLines.length} 行ありました）`);
  }

  // 集計用カウンタとエラーリストを初期化する
  let imported = 0;
  const errors: Array<{ row: number; message: string }> = [];

  // データ行を 1 件ずつ処理する (部分成功を許可するため、1 件エラーでも他を続ける)
  for (let i = 0; i < dataLines.length; i += 1) {
    // CSV の行番号は 1-indexed のヘッダを含めて数えるため +2 する (エラー表示用)
    const rowNum = i + 2;
    // 現在の行を取り出す
    const line = dataLines[i];

    // カンマで分割して各セルを取り出す (前後の空白・引用符を除去)
    const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));

    // 件名セルを取り出す
    const title = cells[titleIndex] ?? '';
    // 件名が空の行はスキップする (ヘッダ後の空行などを無視する)
    if (!title) continue;

    // 本文セルを取り出す (未指定なら空文字)
    const body = bodyIndex !== -1 ? (cells[bodyIndex] ?? '') : '';

    // 優先度セルを日本語から Priority 型へ変換する (未指定または未知値は Medium にフォールバック)
    const priorityRaw = priorityIndex !== -1 ? (cells[priorityIndex] ?? '') : '';
    const priority: Priority = PRIORITY_MAP[priorityRaw] ?? 'Medium';

    // 期限日セルを Date に変換する (形式が不正なら null として解決期限なしにする)
    let resolutionDueAt: Date | null = null;
    if (dueDateIndex !== -1) {
      // 期限日セルの値を取り出す
      const dueDateRaw = cells[dueDateIndex] ?? '';
      if (dueDateRaw) {
        // YYYY-MM-DD 形式を Date オブジェクトに変換する
        const parsed = new Date(dueDateRaw);
        if (isNaN(parsed.getTime())) {
          // 変換に失敗した (不正な形式) 場合はエラーとして記録してこの行をスキップ
          errors.push({ row: rowNum, message: `期限日の形式が正しくありません: "${dueDateRaw}"（YYYY-MM-DD 形式で入力してください）` });
          // 次の行へ進む (部分成功なので continue)
          continue;
        }
        // 変換できた値を解決期限として使う
        resolutionDueAt = parsed;
      }
    }

    // チケットを 1 件作成する (失敗してもループを続けて部分成功を許可する)
    try {
      // リポジトリ経由でチケットを DB に保存する
      await repos.tickets.create({
        title, // 件名
        body, // 本文 (空文字も許容)
        priority, // 優先度
        categoryId: null, // CSV インポートではカテゴリ未指定 (後から設定できる)
        creatorId, // セッションのユーザーが起票者になる
        tenantId, // テナントスコープを必ず付与する (クロステナント防止)
        status: initialStatus, // Lite: Open / Pro: New
        resolutionDueAt, // 期限日 (未指定なら null)
      });
      // 成功カウンタをインクリメント
      imported += 1;
    } catch (err) {
      // チケット作成エラーを行番号と共に記録する (他の行は継続)
      const message = err instanceof Error ? err.message : 'チケットの作成に失敗しました';
      errors.push({ row: rowNum, message });
    }
  }

  // 成功件数とエラー一覧を返す
  return { imported, errors };
}
