'use server';

// CSV テキストからチケットを一括作成するサーバーアクション (Phase 3 CSVインポート)
// docs/smb-dx-pivot-plan.md §4 Phase 3「CSV インポート」に対応

// セッション取得
import { auth } from '@/lib/auth';
// ページキャッシュを無効化する Next.js の関数
import { revalidatePath } from 'next/cache';
// リポジトリ束 (チケット作成用)
import { repos } from '@/data';
// エージェント権限判定 (agent または admin のとき true)
import { isAgent } from '@/lib/role';
// 連打防止のための共通レート制限ヘルパー (超過時は RateLimitError を throw)
import { enforceRateLimit } from '@/lib/rate-limit';
// テナントの動作モード (lite | pro) を取得するヘルパー
import { getCurrentTenantMode } from '@/lib/tenant';
// RFC 4180 準拠の CSV パーサ と共有定数 (サーバー / クライアント共通実装)
import { parseCsvLine, MAX_CSV_BYTES } from '@/lib/csv';
// 優先度・ステータスのドメイン型
import type { Priority, TicketStatus } from '@/domain/types';
// CSV インポート完了後に他エージェントへ未読カウントを即時配信するヘルパー
import { broadcastUnreadCountToMany } from '@/features/notifications/notify';

// 1 インポートあたりの最大行数 (これを超えたらエラー)
const MAX_ROWS = 200;
// MAX_CSV_BYTES は @/lib/csv から import して使う (src/features/.../CsvImportForm.tsx と共有)
// チケット件名の最大文字数 (createTicketSchema と合わせる)
const TITLE_MAX_LENGTH = 200;
// チケット本文の最大文字数 (createTicketSchema と合わせる)
const BODY_MAX_LENGTH = 10_000;

// CSV の優先度文字列 (日本語) を Priority 型にマップする対応表
// 一元管理することで「高」「中」「低」の定義が 1 か所に集まる
const PRIORITY_MAP: Record<string, Priority> = {
  高: 'High', // 「高」→ High
  中: 'Medium', // 「中」→ Medium
  低: 'Low', // 「低」→ Low
};

// YYYY-MM-DD 形式の日付文字列をローカル時刻の Date に変換する純粋関数
// `new Date('YYYY-MM-DD')` は UTC 0 時として解釈されるため JST 環境では前日になる問題を回避する
function parseDateLocal(dateStr: string): Date | null {
  // ハイフンで分割して年・月・日を取り出す
  const parts = dateStr.split('-');
  // 3 要素 (年・月・日) がなければ不正フォーマット
  if (parts.length !== 3) return null;
  // 各部分を整数に変換する
  const year = parseInt(parts[0] ?? '', 10);
  const month = parseInt(parts[1] ?? '', 10); // 1 始まり (後で 0 始まりに調整)
  const day = parseInt(parts[2] ?? '', 10);
  // いずれかが NaN なら不正フォーマット
  if (isNaN(year) || isNaN(month) || isNaN(day)) return null;
  // `new Date(year, month-1, day)` はローカル時刻の午前 0 時を生成する (UTC ではない)
  const d = new Date(year, month - 1, day);
  // 実際に有効な日付かを確認する (例: 2 月 30 日は 3 月に繰り越されるため不正と判断)
  if (d.getFullYear() !== year || d.getMonth() + 1 !== month || d.getDate() !== day) return null;
  // 有効な Date を返す
  return d;
}

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

  // レート制限を認証直後・高コスト処理前に適用する。
  // サイズチェックより先に行うことで、制限超過のリクエストが
  // Buffer.byteLength や CSV パースなどの CPU コストを発生させないようにする。
  enforceRateLimit(`csv-import:${session.user.id}`, { limit: 5, windowMs: 60_000 });

  // セッションから tenantId と起票者 ID を取り出す
  const tenantId = session.user.tenantId;
  const creatorId = session.user.id;

  // CSV テキスト全体のサイズをチェックする (DoS / 過大ペイロードの防止)
  // Buffer.byteLength で実際のバイト数を計測する (日本語は UTF-8 で 3 bytes / 文字)
  if (Buffer.byteLength(csvText, 'utf8') > MAX_CSV_BYTES) {
    throw new Error(`CSV ファイルのサイズが大きすぎます（上限 ${MAX_CSV_BYTES / 1024}KB）`);
  }

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
  // RFC 4180 パーサでヘッダ列名の配列を得る (引用符内のカンマにも対応)
  // ヘッダ行の引用符が閉じられていない場合はここで SyntaxError が投れ、catch されずに
  // importTickets 全体のエラーとして呼び出し元 (CsvImportForm) に表示される (意図した動作)
  const headers = parseCsvLine(headerLine ?? '');

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

    // RFC 4180 パーサで各セルを取り出す (引用符内のカンマにも対応)
    // 引用符が閉じられていない場合は parseCsvLine が SyntaxError を投げるため、
    // ループ内で catch して行単位のエラーとして記録し、次の行の処理を続ける
    let cells: string[];
    try {
      cells = parseCsvLine(line ?? '');
    } catch {
      // 引用符の閉じ忘れ等の CSV 書式エラー: 行全体をスキップしてエラーを積む
      errors.push({ row: rowNum, message: 'CSV の形式が正しくありません（引用符が閉じられていない可能性があります）' });
      continue;
    }

    // 件名セルを取り出す
    const titleRaw = cells[titleIndex] ?? '';
    // 件名が空の行はエラーとして記録してスキップする (静かにスキップせずユーザーに通知する)
    if (!titleRaw) {
      errors.push({ row: rowNum, message: '件名が空です' });
      continue;
    }
    // 件名が長すぎる場合はエラーとして記録してこの行をスキップ (DB の制約前に弾く)
    if (titleRaw.length > TITLE_MAX_LENGTH) {
      errors.push({ row: rowNum, message: `件名が長すぎます（${TITLE_MAX_LENGTH}文字以内にしてください）` });
      continue;
    }
    // 検証済みの件名を確定する
    const title = titleRaw;

    // 本文セルを取り出す (未指定なら空文字)
    const bodyRaw = bodyIndex !== -1 ? (cells[bodyIndex] ?? '') : '';
    // 本文が長すぎる場合はエラーとして記録してこの行をスキップ
    if (bodyRaw.length > BODY_MAX_LENGTH) {
      errors.push({ row: rowNum, message: `内容が長すぎます（${BODY_MAX_LENGTH}文字以内にしてください）` });
      continue;
    }
    // 検証済みの本文を確定する
    const body = bodyRaw;

    // 優先度セルを日本語から Priority 型へ変換する
    const priorityRaw = priorityIndex !== -1 ? (cells[priorityIndex] ?? '') : '';
    // 空文字は「未指定」として Medium にフォールバック (省略を許容する)。
    // ただし空文字でない場合に PRIORITY_MAP に存在しない値は、タイポや意図しない値の可能性が高いため
    // エラーとして記録してスキップする (サイレントに Medium 扱いすると誤ったデータが入ってしまうため)。
    if (priorityRaw && !(priorityRaw in PRIORITY_MAP)) {
      errors.push({
        row: rowNum,
        message: `優先度の値が正しくありません: "${priorityRaw}"（高・中・低 のいずれかを指定してください）`,
      });
      continue;
    }
    // 空文字または未指定の場合は Medium にフォールバックする
    const priority: Priority = PRIORITY_MAP[priorityRaw] ?? 'Medium';

    // 期限日セルを Date に変換する (形式が不正なら null として解決期限なしにする)
    let resolutionDueAt: Date | null = null;
    if (dueDateIndex !== -1) {
      // 期限日セルの値を取り出す
      const dueDateRaw = cells[dueDateIndex] ?? '';
      if (dueDateRaw) {
        // YYYY-MM-DD 形式をローカル時刻の Date に変換する
        // (`new Date('YYYY-MM-DD')` は UTC 午前 0 時なので JST 環境で前日になるバグを回避)
        const parsed = parseDateLocal(dueDateRaw);
        if (parsed === null) {
          // 変換に失敗した (不正な形式) 場合はエラーとして記録してこの行をスキップ
          errors.push({ row: rowNum, message: `期限日の形式が正しくありません: "${dueDateRaw}"（YYYY-MM-DD 形式で入力してください）` });
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
      // 内部エラー (Prisma 例外等) をサーバーログに記録する (スキーマ情報の漏洩防止のため UI には返さない)
      console.error(`[importTickets] 行 ${rowNum} のチケット作成に失敗:`, err);
      // ユーザーには汎用メッセージのみ返す (Prisma のエラー詳細をフロントに漏らさない)
      errors.push({ row: rowNum, message: 'チケットの作成に失敗しました。内容を確認してください。' });
    }
  }

  // インポートでチケットが 1 件以上作成された場合のコミット後処理
  if (imported > 0) {
    // チケット一覧のキャッシュを無効化する (revalidatePath を呼ばないと古いデータが表示され続ける)
    revalidatePath('/tickets');

    // 同テナントの他エージェント (インポート実行者を除く) に一括追加を通知する。
    // 個別チケットごとではなく 1 通にまとめることで通知の過多を防ぐ (200 件追加でも通知は 1 通)。
    // 注意: 現行の NotificationType に "new_ticket" 相当の型が未定義のため
    // 利用可能な型の中で最も意味の近い 'commented' を暫定利用している。
    // 将来的には NotificationType に 'imported' 等を追加して置き換えることを推奨する。
    const agents = await repos.users.listAgents(tenantId); // 当該テナントの全エージェント一覧を取得
    // インポート実行者自身への通知は不要なので除外する (自分が実施したことは知っているため)
    const otherAgents = agents.filter((a) => a.id !== creatorId);
    if (otherAgents.length > 0) {
      // 各エージェントへ通知を 1 件ずつ DB に書き込む
      for (const agent of otherAgents) {
        await repos.notifications.create({
          userId: agent.id, // 受信者: 各エージェント
          type: 'commented', // 暫定: NotificationType に imported がないため commented で代替
          message: `${imported} 件のチケットが CSV インポートで追加されました`, // 表示文言
          ticketId: null, // バッチインポートは単一チケットに紐づかないため null
          tenantId, // テナントスコープ
        });
      }
      // 未読件数を SSE で即時配信して通知ベルに反映させる
      await broadcastUnreadCountToMany(
        otherAgents.map((a) => a.id), // 通知対象の agent ID 一覧
        tenantId, // テナントスコープ
      );
    }
  }

  // 成功件数とエラー一覧を返す
  return { imported, errors };
}
