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
// フォローアップ (2026-07-15 #3): CSV エクスポートの「起票日時」列 (formatDateTimeISO) と対になる
// パーサ。既存 Excel 台帳を再現するインポートで、元の起票日時を保持できるようにする
import { parseDateTimeJST } from '@/lib/format-date';
// 優先度・ステータス・テナントモードのドメイン型
import type {
  Priority,
  TicketStatus,
  TenantMode,
  NotificationType,
  UserSummary,
} from '@/domain/types';
// モードに応じた初期ステータスを返す共通関数（メール取り込み・LINE 取り込みと同一ロジックを共有し DRY を維持する）。
// getCompletionStatuses は §3.1 フォローアップ (2026-07-10) で追加: インポート時に「状況」列が
// 完了系ステータスを指定していた場合、resolvedAt をインポート時刻で設定するために使う
import {
  initialStatusForMode,
  getCompletionStatuses,
  hasRespondedByImportStatus,
} from '@/domain/ticket-status';
// §3.1 フォローアップ (2026-07-10): 「状況」列の日本語ラベルから TicketStatus を逆引きする
// mode-aware ヘルパー (getStatusLabel の逆写像)、およびエラーメッセージ用の有効ラベル一覧取得
import { resolveStatusFromLabel, getStatusLabelsForMode } from '@/lib/constants';
// CSV インポート完了後に他エージェントへ未読カウントを即時配信するヘルパー
import { broadcastUnreadCountToMany } from '@/features/notifications/notify';
// Phase 4 課金: 月間チケット上限チェック (Web フォーム・メール/LINE 取り込みと共有)
import { getMonthlyTicketQuota } from '@/lib/tenant-plan';
// Phase 4: Slack/Teams/Chatwork 外部通知ヘルパー (Web フォーム・メール・LINE 取り込みと共有)
import { notifyOutboundBestEffort } from '@/lib/outbound-notify';
// 優先度から初回応答期限を計算する SLA ヘルパー (Web フォーム・メール・LINE 取り込みと共有)
import { calculateFirstResponseDueAt, calculateResolutionDueAt } from '@/lib/sla';
// フォローアップ (2026-07-13): 監査で発見したギャップの解消。担当割当メールを
// updateTicketAssignee (画面からの手動アサイン) と同じ経路で送るためのヘルパー群。
// sendBatchEmail はエスカレーション一斉メール (escalateTicket) と共有する送信共通処理 (§6 DRY)
import { sendBatchEmail } from '@/lib/batch-email';
import { renderAssignedBatchEmail } from '@/lib/ticket-email';
import { resolveAppBaseUrl } from '@/lib/app-url';

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

// エラーメッセージにセル値をそのまま埋め込むとレスポンスが肥大化しうるため、100 文字を超える場合は
// 末尾を省略記号に置き換えて切り詰める共通ヘルパー (優先度・期限日・状況の 3 列で同じ処理が重複していたため抽出)
function truncateForDisplay(value: string): string {
  // 100 文字以内ならそのまま返す
  if (value.length <= 100) return value;
  // 100 文字目までを取り、末尾に省略記号を付ける
  return `${value.slice(0, 100)}…`;
}

// CSV セルを取り出し、trim して空文字なら null にする共通ヘルパー (拠点・カテゴリ列で共有)。
// /code-review ultra 指摘対応 (2026-07-11): 「列インデックスが -1 でなければセルを取り出して
// trim し、空文字は null に正規化する」処理が拠点・カテゴリで重複していたため共通化する (§6 DRY)。
// 実在確認はテナントの一覧を持つ呼び出し側で行う (この関数は DB アクセスを持たない純粋関数のまま保つ)。
function extractOptionalCell(cells: string[], index: number): string | null {
  const raw = index !== -1 ? (cells[index] ?? '').trim() : '';
  return raw || null;
}

// 「列が使われている場合のみ一覧取得して名前 → ID の Map を作る」処理を条件付きで行う共通ヘルパー
// (拠点・カテゴリで共有)。/code-review ultra 指摘対応 (2026-07-11): ほぼ同じ「列が無ければ不要な
// DB アクセスを避け、あれば一覧取得して Map 化する」処理が拠点・カテゴリで重複していたため共通化する
// (§6 DRY)。呼び出し側で Promise.all にまとめることで、拠点とカテゴリ両方の列がある CSV でも
// DB 往復を直列ではなく並列にできる (§8 パフォーマンス)。
async function buildNameToIdMap(
  shouldFetch: boolean, // 列が実際に使われる (インデックスが有効、かつ該当モードで許可されている) か
  fetchItems: () => Promise<Array<{ id: string; name: string }>>,
): Promise<Map<string, string>> {
  if (!shouldFetch) return new Map();
  const items = await fetchItems();
  return new Map(items.map((item) => [item.name, item.id]));
}

// 名前を ID に解決し、見つからなければエラーメッセージを返す共通ヘルパー (拠点・カテゴリで共有)。
// /code-review ultra 指摘対応 (2026-07-11): 「Map から引き、無ければタイポ等の可能性が高いとして
// エラーメッセージを組み立てる」処理が拠点・カテゴリで重複していたため共通化する (§6 DRY)。
function resolveNameToId(
  name: string,
  byName: Map<string, string>,
  entityLabel: string, // エラーメッセージに使う日本語ラベル (例: '拠点' 'カテゴリ')
): { ok: true; id: string } | { ok: false; message: string } {
  const id = byName.get(name);
  if (!id) {
    return {
      ok: false,
      message: `${entityLabel}が見つかりません: "${name}"（設定済みの${entityLabel}名を指定してください）`,
    };
  }
  return { ok: true, id };
}

// 「チケットの所有権に関わる」名前解決 (担当者・起票者) の共通ヘルパー。
// resolveNameToId と異なり、同姓同名がキー衝突でどちらか一方へ無言で misassign されるのを防ぐため、
// 解決を試みる前に重複チェックを行う「重複チェック → resolveNameToId」という 2 手順をまとめて持つ。
// フォローアップ (2026-07-14): 元々は担当者名解決の行処理にインライン実装されていたが、起票者名解決も
// 全く同型の 2 手順を必要とするため、2 箇所目の重複が生じた時点で共通化する (§6 DRY)。
function resolveOwnedName(
  name: string,
  byName: Map<string, string>,
  duplicateNames: Set<string>,
  entityLabel: string, // エラーメッセージに使う日本語ラベル (例: '担当者' '起票者')
  duplicatePopulationLabel: string, // 重複しうる母集団の呼称 (例: 担当者は「エージェント」、起票者は「メンバー」)
  duplicateGuidance: string, // 重複時のエラーメッセージ末尾に付ける案内文 (例: '担当者を設定してください')
): { ok: true; id: string } | { ok: false; message: string } {
  if (duplicateNames.has(name)) {
    return {
      ok: false,
      message: `${entityLabel}名が重複しています: "${name}"（同じ名前の${duplicatePopulationLabel}が複数存在するため一意に特定できません。取り込み後に画面から${duplicateGuidance}）`,
    };
  }
  return resolveNameToId(name, byName, entityLabel);
}

// 名前 → ID の対応表を作りつつ、同姓同名 (重複名) を集合として検出する共通ヘルパー。
// 拠点・カテゴリと異なり、担当者・起票者は「チケットの所有権に関わる」列であり、同姓同名を
// Map のキー衝突でどちらか一方へ無言で misassign すると事故になるため、専用の重複検出が必要になる
// (buildNameToIdMap は「列が使われるかどうか」の分岐のみを共有する用途なのでここでは使わない)。
// フォローアップ (2026-07-14): 元々は担当者名解決にインライン実装されていたが、起票者名解決も
// 同じ形の重複検出を必要とするため、2 箇所目の重複が生じた時点で共通化する (§6 DRY)。
function buildNameToIdMapWithDuplicates(items: UserSummary[]): {
  byName: Map<string, string>;
  duplicateNames: Set<string>;
} {
  const byName = new Map<string, string>();
  const nameCounts = new Map<string, number>();
  for (const item of items) {
    nameCounts.set(item.name, (nameCounts.get(item.name) ?? 0) + 1);
    byName.set(item.name, item.id);
  }
  const duplicateNames = new Set<string>();
  for (const [name, count] of nameCounts) {
    if (count > 1) duplicateNames.add(name);
  }
  return { byName, duplicateNames };
}

// CSV インポート完了後、対象ユーザー群へバッチ通知 (1 通ずつ) を送るベストエフォート・ヘルパー。
// /code-review ultra 指摘対応 (2026-07-13): 「全エージェントへの追加通知 ('imported')」と
// 「担当者への割当通知 ('assigned')」が、DB 書き込み → 失敗のエージェント別詳細ログ → SSE
// 未読件数配信、という同型の処理をそれぞれ個別に実装しており 2 箇所目の重複になっていたため、
// ここに共通化する (§6 DRY)。通知書き込み・SSE 配信の失敗はいずれもチケット作成の成否に
// 影響させないベストエフォートとして扱う (呼び出し元と同じ方針)。
async function notifyImportBatch(
  recipientIds: string[], // 通知対象ユーザー ID 一覧 (呼び出し元で自己除外済み)
  tenantId: string, // テナントスコープ
  type: NotificationType, // 通知種別 ('imported' | 'assigned')
  messageFor: (recipientId: string) => string, // 受信者ごとの通知文言を組み立てる関数
  logPrefix: string, // ログの先頭に付ける識別子 (例: '[importTickets] 担当割当通知')
): Promise<void> {
  // 対象が居なければ何もしない (早期リターン)
  if (recipientIds.length === 0) return;
  // 各ユーザーへの通知を並列で DB に書き込む。Promise.allSettled を使い、1 件の書き込み失敗が
  // 他ユーザーへの通知配信や SSE broadcast をブロックしないようにする
  const results = await Promise.allSettled(
    recipientIds.map((userId) =>
      repos.notifications.create({
        userId,
        type,
        message: messageFor(userId),
        ticketId: null, // バッチ通知は単一チケットに紐づかないため null
        tenantId,
      }),
    ),
  );
  // 失敗した通知件数と、ユーザーごとの失敗理由をサーバーログに記録する
  // (チケット作成の成否には影響しない。CLAUDE.md §6: エラーを握り潰さない)
  const failedCount = results.filter((r) => r.status === 'rejected').length;
  if (failedCount > 0) {
    console.warn(`${logPrefix} ${failedCount} 件の通知書き込みに失敗しました`);
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.warn(`${logPrefix} ユーザー ${recipientIds[i]} への通知書き込みに失敗:`, r.reason);
      }
    });
  }
  // 未読件数を SSE で即時配信して通知ベルに反映させる。
  // broadcast は通知 DB 書き込みより後に行う必要があるため、上の Promise.allSettled を待ってから実行する。
  // ここで例外が発生してもチケット作成は完了済みなので、ユーザーに失敗として返さず警告ログに留める。
  try {
    await broadcastUnreadCountToMany(recipientIds, tenantId);
  } catch (err) {
    console.warn(`${logPrefix} SSE broadcast に失敗しました（チケット作成は成功）:`, err);
  }
}

// CSV インポートで担当者に割り当てられたエージェントへメールで通知するベストエフォート・ヘルパー。
// フォローアップ (2026-07-13): 監査で発見したギャップの解消。画面からの手動アサイン
// (updateTicketAssignee) は担当者へアプリ内通知に加えてメールも届くのに対し、CSV インポートで
// 「担当者」列から初期担当者を設定してもアプリ内通知しか届かず、アプリを開かない担当者は
// 気づけなかった (§2 ギャップ分析表「アプリ開かない前提 → メール通知を主軸に切替」に反する)。
// 個々のチケットごとには送らず、担当件数をまとめて 1 通にする (notifyImportBatch と同じ方針)。
async function notifyAssignedAgentsByEmail(
  assignedAgentIds: string[], // メール送信対象のエージェント ID 一覧 (呼び出し元で自己除外済み)
  tenantId: string, // テナントスコープ
  assignedCounts: Map<string, number>, // エージェントごとの割当件数
): Promise<void> {
  // 対象が居なければ何もしない (早期リターン)
  if (assignedAgentIds.length === 0) return;
  // /code-review ultra 指摘対応 (2026-07-13): 以前はベース URL 解決だけを try/catch していたため、
  // 続く listAgentEmails (DB 呼び出し) が失敗すると例外が捕捉されずに importTickets 全体の
  // Promise.all まで伝播し、チケット作成が既に成功しているにもかかわらず CSV インポート自体が
  // 失敗したように見えてしまっていた (notifyImportBatch 等、同ファイルの他のベストエフォート
  // 処理と方針が食い違っていた)。ベース URL 解決から送信完了までをまとめて 1 つの try で囲む。
  try {
    // ベース URL を解決する (production で NEXTAUTH_URL 未設定なら throw される)
    const baseUrl = resolveAppBaseUrl();
    // メール送信先には email が必要 (agentsForAssignee/listAgents が返す UserSummary には email が
    // 含まれないため、エスカレーション一斉メールと同じ専用メソッドで id→email を解決する)
    const agentEmails = await repos.users.listAgentEmails(tenantId);
    const assignedIdSet = new Set(assignedAgentIds);
    const recipients = agentEmails.filter((a) => assignedIdSet.has(a.id));
    // 退職・削除等で email が引けなかったエージェントがいればログに残す (CLAUDE.md §6:
    // エラーを握り潰さない。何件送れなかったかが分かれば十分なので件数のみ記録する)
    const missingCount = assignedAgentIds.length - recipients.length;
    if (missingCount > 0) {
      console.warn(
        `[importTickets] 担当割当メール: ${missingCount} 件のエージェントの email が見つかりませんでした`,
      );
    }
    // 送信・失敗件数ログはエスカレーション一斉メールと共有の共通ヘルパーに委譲する (§6 DRY)
    await sendBatchEmail(
      recipients,
      (agent) =>
        renderAssignedBatchEmail({
          count: assignedCounts.get(agent.id) ?? 0,
          ticketsUrl: `${baseUrl}/tickets`, // 単一チケットに紐づかないため一覧ページへリンクする
        }),
      '[importTickets] 担当割当メール',
    );
  } catch (err) {
    // ベース URL 解決失敗・email 一覧取得失敗等はメール送信全体を諦める
    // (チケット作成の成否には影響しない。呼び出し元は Promise.all で並行実行するため、
    // ここで例外を伝播させると他のベストエフォート処理まで巻き込んで importTickets 全体が
    // 失敗したように見えてしまう)
    console.error('[importTickets] 担当割当メール送信処理に失敗しました', err);
  }
}

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

// CSV 1 行分のバリデーション済みデータ
interface ValidatedRow {
  title: string; // 検証済みの件名
  body: string; // 検証済みの本文
  priority: Priority; // 変換済みの優先度
  resolutionDueAt: Date | null; // 変換済みの期限日 (null = 未指定)
  locationName: string | null; // 拠点名 (trim 済み。null = 未指定。実在確認は DB を持つ呼び出し側で行う)
  // フォローアップ (2026-07-11): カテゴリ名 (trim 済み。null = 未指定。実在確認は拠点と同じく
  // DB を持つ呼び出し側で行う)。CSV エクスポートは「カテゴリ」列を出力するのにインポート側に
  // 対応する読み取りが無く、エクスポート→編集→再インポートの往復でカテゴリ情報が失われていた
  categoryName: string | null;
  // §3.1 フォローアップ (2026-07-10): 変換済みのステータス (null = 列なし/セル空 → 呼び出し側が
  // initialStatusForMode の既定値にフォールバックする)
  status: TicketStatus | null;
  // フォローアップ (2026-07-13): 担当者名 (trim 済み。null = 未指定。実在確認は拠点/カテゴリと
  // 同じく DB を持つ呼び出し側で行う)。CSV エクスポートは「担当者」列を出力するのにインポート側に
  // 対応する読み取りが無く、エクスポート→編集→再インポートの往復で担当者情報が失われていた
  assigneeName: string | null;
  // フォローアップ (2026-07-14): 起票者名 (trim 済み。null = 未指定。実在確認は担当者と同じく
  // DB を持つ呼び出し側で行う)。CSV エクスポートは「起票者」列を出力するのにインポート側に
  // 対応する読み取りが無く、常にインポート実行者が起票者としてハードコードされていたため、
  // エクスポート→編集→再インポートの往復で元の起票者 (依頼者本人) の情報が失われていた。
  // これはチケットの閲覧権限 (依頼者は自分の起票したチケットしか見えない) と通知の宛先を
  // 誤らせる回帰であり、拠点/カテゴリ/担当者よりも影響が大きい
  creatorName: string | null;
  // フォローアップ (2026-07-15 #3): 変換済みの起票日時 (null = 列なし/セル空 → 呼び出し側が
  // インポート時刻にフォールバックする)。CSV エクスポートは「起票日時」列を出力するのに
  // インポート側に対応する読み取りが無く、既存 Excel 台帳の移行のたびに元の起票日時が
  // インポート実行時刻に付け替えられ、月次件数の集計や経過日数の把握が壊れていた
  createdAt: Date | null;
}

// CSV ヘッダの列インデックス一覧
interface ColumnIndices {
  titleIndex: number; // 「件名」列
  bodyIndex: number; // 「内容」列 (-1 = 未指定)
  dueDateIndex: number; // 「期限日」列 (-1 = 未指定)
  priorityIndex: number; // 「優先度」列 (-1 = 未指定)
  locationIndex: number; // 「拠点」列 (-1 = 未指定)
  categoryIndex: number; // 「カテゴリ」列 (-1 = 未指定。フォローアップ 2026-07-11)
  statusIndex: number; // 「状況」列 (-1 = 未指定。§3.1 フォローアップ)
  assigneeIndex: number; // 「担当者」列 (-1 = 未指定。フォローアップ 2026-07-13)
  creatorIndex: number; // 「起票者」列 (-1 = 未指定。フォローアップ 2026-07-14)
  createdAtIndex: number; // 「起票日時」列 (-1 = 未指定。フォローアップ 2026-07-15 #3)
}

// CSV 1 行分のセルを受け取り、バリデーション・型変換を行う純粋関数。
// DB アクセスや副作用を持たないため、単体テストが書きやすい。
// 成功時は { ok: true, data } を返し、失敗時は { ok: false, message } を返す。
function validateImportRow(
  cells: string[], // パース済みのセル配列
  indices: ColumnIndices, // 各列のインデックス
  mode: TenantMode, // §3.1 フォローアップ: 「状況」列のラベル解釈を Lite/Pro で切り替えるために必要
  now: Date, // フォローアップ (2026-07-15 #3): 起票日時が未来の値でないかの検証基準時刻
): { ok: true; data: ValidatedRow } | { ok: false; message: string } {
  // 引数オブジェクトから各列インデックスを取り出す
  const {
    titleIndex,
    bodyIndex,
    dueDateIndex,
    priorityIndex,
    locationIndex,
    categoryIndex,
    statusIndex,
    assigneeIndex,
    creatorIndex,
    createdAtIndex,
  } = indices;

  // 件名セルを取り出す。前後の空白は除去する (空白だけのセルを「入力あり」と誤判定しないため)
  const titleRaw = (cells[titleIndex] ?? '').trim();
  // 件名が空の行はエラーとして記録してスキップする (静かにスキップせずユーザーに通知する)
  if (!titleRaw) {
    return { ok: false, message: '件名が空です' };
  }
  // 件名が長すぎる場合はエラーとして記録する (DB の制約前に弾く)
  if (titleRaw.length > TITLE_MAX_LENGTH) {
    return { ok: false, message: `件名が長すぎます（${TITLE_MAX_LENGTH}文字以内にしてください）` };
  }

  // 本文セルを取り出す (未指定なら空文字)。前後の空白は除去する
  // (本文は空文字自体を許容するが、件名と同様に空白だけが残った見た目を避ける)
  const bodyRaw = (bodyIndex !== -1 ? (cells[bodyIndex] ?? '') : '').trim();
  // 本文が長すぎる場合はエラーとして記録する
  if (bodyRaw.length > BODY_MAX_LENGTH) {
    return { ok: false, message: `内容が長すぎます（${BODY_MAX_LENGTH}文字以内にしてください）` };
  }

  // 優先度セルを日本語から Priority 型へ変換する
  const priorityRaw = priorityIndex !== -1 ? (cells[priorityIndex] ?? '') : '';
  // 空文字でない場合に PRIORITY_MAP に存在しない値はタイポや意図しない値なのでエラーとする
  // Object.hasOwn を使い、Object.prototype 上のキー (__proto__ 等) を誤って通過させない
  if (priorityRaw && !Object.hasOwn(PRIORITY_MAP, priorityRaw)) {
    // エラーメッセージにセル値を反映する際は 100 文字に切り詰め、レスポンス肥大化を防ぐ
    const priorityDisplay = truncateForDisplay(priorityRaw);
    return {
      ok: false,
      message: `優先度の値が正しくありません: "${priorityDisplay}"（高・中・低 のいずれかを指定してください）`,
    };
  }
  // 空文字または未指定の場合は Medium にフォールバックする
  const priority: Priority = PRIORITY_MAP[priorityRaw] ?? 'Medium';

  // 期限日セルを Date に変換する。フォローアップ (2026-07-15 #3): 「期限日」は Lite モード専用の
  // 依頼者手動入力欄で、Pro モードはカテゴリ/優先度から自動算出される SLA のみを使う
  // (TicketForm.tsx で `mode === 'pro'` のとき欄自体を非表示にしているのと同じ区分。カテゴリ名列を
  // Lite で無視する上の分岐と対称)。Pro モードでは列に値があっても無視して自動算出に一本化しないと、
  // ここで永続化した手動値が後から updateTicketPriority の優先度変更で無警告に上書きされ、
  // 「Pro は手動上書きの経路が無い」という同フォローアップの前提が崩れる
  let resolutionDueAt: Date | null = null;
  if (dueDateIndex !== -1 && mode !== 'pro') {
    // 期限日セルの値を取り出す
    const dueDateRaw = cells[dueDateIndex] ?? '';
    if (dueDateRaw) {
      // YYYY-MM-DD 形式をローカル時刻の Date に変換する
      const parsed = parseDateLocal(dueDateRaw);
      if (parsed === null) {
        // 変換に失敗した (不正な形式) 場合はエラーとして記録する
        // エラーメッセージにセル値を反映する際は 100 文字に切り詰め、レスポンス肥大化を防ぐ
        const dueDateDisplay = truncateForDisplay(dueDateRaw);
        return {
          ok: false,
          message: `期限日の形式が正しくありません: "${dueDateDisplay}"（YYYY-MM-DD 形式で入力してください）`,
        };
      }
      // 変換できた値を解決期限として使う
      resolutionDueAt = parsed;
    }
  }

  // 拠点セル・カテゴリセル・担当者セル・起票者セルを取り出す (未指定なら null。extractOptionalCell を共有)
  const locationName = extractOptionalCell(cells, locationIndex);
  const categoryName = extractOptionalCell(cells, categoryIndex);
  const assigneeName = extractOptionalCell(cells, assigneeIndex);
  const creatorName = extractOptionalCell(cells, creatorIndex);

  // §3.1 フォローアップ (2026-07-10): 「状況」セルをテナントの現在モードのラベルから TicketStatus へ
  // 変換する。既存の問い合わせ管理 Excel には既に完了済みの行が大量に混ざっているのが実情で、
  // これを解決できないと CSV インポートのたびに全件が「未対応/新規」になってしまい
  // 「最短で Excel から卒業できる」という北極星指標 (§0) に反する。
  const statusRaw = statusIndex !== -1 ? (cells[statusIndex] ?? '').trim() : '';
  let status: TicketStatus | null = null;
  if (statusRaw) {
    // 現在のモードで表示されているラベルから逆引きする (getStatusLabel の逆写像)
    const resolved = resolveStatusFromLabel(statusRaw, mode);
    if (resolved === null) {
      // 優先度と同じ方針: タイポや意図しない値を静かに既定値へフォールバックさせず、エラー行にする
      const statusDisplay = truncateForDisplay(statusRaw);
      // 入力できる値をエラーメッセージに具体的に示す (現在モードのラベル一覧)
      const validLabels = getStatusLabelsForMode(mode).join('・');
      return {
        ok: false,
        message: `状況の値が正しくありません: "${statusDisplay}"（${validLabels} のいずれかを指定してください）`,
      };
    }
    // /code-review ultra 指摘対応 (2026-07-10): 「エスカレーション」はステータスの一種に
    // 見えるが、実際には escalatedAt/escalationReason の記録や全エージェントへの通知
    // (escalateTicket, src/features/tickets/actions/update-ticket.ts) を伴う専用フローを
    // 持つ。CSV インポートはこれらの付随情報を収集していないため、そのまま Escalated で
    // 起票すると escalatedAt が null のまま「エスカレーション」バッジだけが付いた、
    // 履歴の無い矛盾したチケットができてしまう。状況列からの直接起票は許可しない
    if (resolved === 'Escalated') {
      return {
        ok: false,
        message:
          '状況「エスカレーション」は CSV インポートでは指定できません（対応中などの別の状況で取り込み、必要であれば取り込み後に画面からエスカレーションしてください）',
      };
    }
    status = resolved;
  }

  // フォローアップ (2026-07-15 #3): 「起票日時」セルを Date に変換する。CSV エクスポートの
  // formatDateTimeISO ('YYYY-MM-DD HH:mm:ss') と対になるパーサ (parseDateTimeJST) を使う。
  // 未指定 (列なし/セル空) の場合は null のまま返し、呼び出し側でインポート時刻にフォールバックする
  let createdAt: Date | null = null;
  if (createdAtIndex !== -1) {
    // 起票日時セルの値を取り出す
    const createdAtRaw = cells[createdAtIndex] ?? '';
    if (createdAtRaw) {
      // 'YYYY-MM-DD HH:mm:ss' 形式を JST の Date に変換する
      const parsed = parseDateTimeJST(createdAtRaw);
      if (parsed === null) {
        // 変換に失敗した (不正な形式) 場合はエラーとして記録する
        const createdAtDisplay = truncateForDisplay(createdAtRaw);
        return {
          ok: false,
          message: `起票日時の形式が正しくありません: "${createdAtDisplay}"（YYYY-MM-DD HH:mm:ss 形式で入力してください）`,
        };
      }
      // 未来の日時は resolvedAt/firstRespondedAt (インポート時刻 = now で近似) より起票日時が
      // 後になり「解決に負の時間がかかった」ような矛盾したデータになるため、エラーとして拒否する
      if (parsed.getTime() > now.getTime()) {
        return {
          ok: false,
          message: '起票日時には現在時刻より過去の日時を指定してください',
        };
      }
      // 変換できた値を起票日時として使う
      createdAt = parsed;
    }
  }

  // 全バリデーション通過: バリデーション済みのデータをそのまま返す。
  // CSV インジェクション対策は書き出し (エクスポート) 時に行う (AuditExportButton 等)。
  // インポート時に ' を付加すると DB に汚染データが保存され、チケット件名が '=formula のように表示される。
  return {
    ok: true,
    data: {
      title: titleRaw,
      body: bodyRaw,
      priority,
      resolutionDueAt,
      createdAt,
      locationName,
      categoryName,
      status,
      assigneeName,
      creatorName,
    },
  };
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
  // 取り込み時刻 (初回応答期限の計算基準。行ごとに新規生成せず統一する)
  const now = new Date();

  // Lite: 'Open'(未対応)、Pro: undefined → DB 既定値 'New'(新規) を使う。
  // メール取り込み・LINE 取り込みと同じ initialStatusForMode を呼ぶことで、
  // モード別初期ステータスの定義が ticket-status.ts に一元化される (DRY 原則)。
  // ?? 'New' は Pro モードで undefined が返ったときに型を TicketStatus に確定するため必要。
  const initialStatus: TicketStatus = initialStatusForMode(mode) ?? 'New';

  // --- CSV パース開始 ---
  // Excel がエクスポートする UTF-8 CSV は先頭にバイトオーダーマーク (BOM: ﻿) を付けることがある。
  // そのままにすると 1 列目の先頭に \uFEFF が残り、headers.indexOf('件名') が -1 になって起票が全滅する。
  // split の前に除去しておく (正規表現の ^ は文字列先頭にのみマッチするため安全)。
  const normalizedCsv = csvText.replace(/^\uFEFF/, '');
  // 改行コード (CRLF / LF どちらにも対応) で行に分割する
  const allLines = normalizedCsv.split(/\r?\n/);
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
  const locationIndex = headers.indexOf('拠点'); // 拠点名 (Phase 4 多拠点。一覧/詳細/CSVエクスポートと対称の項目)
  // フォローアップ (2026-07-11): カテゴリ名 (CSV エクスポートの「カテゴリ」列と対称の項目。
  // 拠点と同じく名前解決が必要なため列インデックスだけここで取得する)
  const categoryIndex = headers.indexOf('カテゴリ');
  const statusIndex = headers.indexOf('状況'); // 状況 (§3.1 フォローアップ。既存 Excel の完了済み行を再現する)
  // フォローアップ (2026-07-13): 担当者名 (CSV エクスポートの「担当者」列と対称の項目。
  // 拠点/カテゴリと同じく名前解決が必要なため列インデックスだけここで取得する)
  const assigneeIndex = headers.indexOf('担当者');
  // フォローアップ (2026-07-14): 起票者名 (CSV エクスポートの「起票者」列と対称の項目。
  // 担当者と同じく名前解決が必要なため列インデックスだけここで取得する)
  const creatorIndex = headers.indexOf('起票者');
  // フォローアップ (2026-07-15 #3): 起票日時 (CSV エクスポートの「起票日時」列と対称の項目。
  // 名前解決は不要なので他の任意列と同じく列インデックスだけ取得する)
  const createdAtIndex = headers.indexOf('起票日時');

  // データ行 (2 行目以降) を取り出す
  const dataLines = nonEmptyLines.slice(1);

  // 最大行数チェック (DoS / リソース枯渇防止)
  if (dataLines.length > MAX_ROWS) {
    throw new Error(
      `1 回のインポートは最大 ${MAX_ROWS} 行です（${dataLines.length} 行ありました）`,
    );
  }

  // Phase 4 課金: 当月チケット起票の残枠を取得する (§6.1 料金プランの月間上限)。
  // CSV インポートは 1 回で最大 MAX_ROWS 件を一括作成できるため、Web フォームと同じ上限チェックを
  // 行わないと Free プランの月間上限 (50 件) を 1 回のインポートで容易に超過できてしまう。
  // remaining はループ内で残り作成可能数として消費し、使い切ったら以降の行をエラーとして記録する。
  // (ここまでの検証を通過したリクエストのみ DB 参照するため、形式エラーで無駄なクエリを発生させない)
  const quota = await getMonthlyTicketQuota(tenantId);

  // 「拠点」「カテゴリ」列が使われている場合のみ名前 → ID の対応表を作る (buildNameToIdMap を共有)。
  // Web フォーム (locationId/categoryId で直接指定) と異なり CSV は名前の文字列で来るため名前解決が
  // 必要。カテゴリは拠点と異なり Pro モード専用の概念 (TicketForm.tsx の `{!isLite && (...)}` /
  // POST /api/tickets の `effectiveCategoryId = mode === 'lite' ? null : ...` 参照) のため、Lite
  // テナントでは列があっても名前解決自体を行わない (categoryId は常に null にする)。
  // フォローアップ (2026-07-13): 「担当者」列も同じ名前解決が必要。拠点と同じく Lite/Pro
  // どちらのモードでも使える概念 (§3.1 用語表「アサイン→担当を決める」) のため、カテゴリと
  // 異なり mode によるガードは行わない。
  // /code-review ultra 指摘対応 (2026-07-13): 担当者は buildNameToIdMap を使わず、生のエージェント
  // 一覧をここで取得する。理由は 2 つ: (1) 後段のインポート後通知 (§ 下部) でも同じ一覧が必要なため、
  // ここで取得したものを再利用して二重取得を避ける (§8 パフォーマンス)。(2) 拠点/カテゴリと異なり
  // 担当者名はチケットの所有権 (誰が対応するか) を左右するため、同姓同名のエージェントが存在する
  // 場合に Map のキー衝突でどちらか一方へ無言で misassign されるのを防ぐ重複検出が必要。
  // フォローアップ (2026-07-14): 起票者も同じ理由で重複検出が必要。ただし起票者はエージェントに
  // 限らず依頼者もなり得るため、agentsForAssignee (listAgents) ではなく listByTenant (全ロール) を
  // 別途取得する。同一テナント内で対象が重なっても listAgents とは目的の異なる独立した取得のため、
  // 拠点・カテゴリ・エージェント一覧と合わせて Promise.all で並列化する (§8 パフォーマンス)。
  const [locationsByName, categoriesByName, agentsForAssignee, usersForCreator] = await Promise.all(
    [
      buildNameToIdMap(locationIndex !== -1, () => repos.locations.listByTenant(tenantId)),
      buildNameToIdMap(categoryIndex !== -1 && mode !== 'lite', () =>
        repos.categories.list(tenantId),
      ),
      assigneeIndex !== -1 ? repos.users.listAgents(tenantId) : Promise.resolve(null),
      creatorIndex !== -1 ? repos.users.listByTenant(tenantId) : Promise.resolve(null),
    ],
  );

  // 「担当者」「起票者」列それぞれの名前 → ID マップと、同姓同名 (重複名) の集合を作る。
  // 拠点/カテゴリの resolveNameToId と異なり、同名が複数存在する場合はどちらか一方を無言で
  // 選ばず、後続のループでエラー行として記録できるよう duplicateNames に集める
  // (buildNameToIdMapWithDuplicates を共有。§6 DRY: 担当者・起票者の 2 箇所目で共通化した)。
  const { byName: agentsByName, duplicateNames: duplicateAgentNames } = agentsForAssignee
    ? buildNameToIdMapWithDuplicates(agentsForAssignee)
    : { byName: new Map<string, string>(), duplicateNames: new Set<string>() };
  const { byName: usersByName, duplicateNames: duplicateCreatorNames } = usersForCreator
    ? buildNameToIdMapWithDuplicates(usersForCreator)
    : { byName: new Map<string, string>(), duplicateNames: new Set<string>() };

  // 集計用カウンタとエラーリストを初期化する
  let imported = 0;
  const errors: Array<{ row: number; message: string }> = [];
  // フォローアップ (2026-07-13): 「担当者」列で割り当てた件数をエージェント別に集計する。
  // updateTicketAssignee (画面からの手動アサイン) は担当者へ 'assigned' 通知を送るが、
  // CSV インポートで初期担当者を設定してもこれまで一切通知していなかった (監査で発見したギャップ)。
  // インポート後にまとめて 1 通ずつ送るための集計 (行ごとに送ると 200 件で 200 通になり得る)
  const assignedCounts = new Map<string, number>();

  // ヘッダ列インデックスをまとめてバリデーション関数へ渡す
  const columnIndices: ColumnIndices = {
    titleIndex,
    bodyIndex,
    dueDateIndex,
    priorityIndex,
    locationIndex,
    categoryIndex,
    statusIndex,
    assigneeIndex,
    creatorIndex,
    createdAtIndex,
  };

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
    } catch (err) {
      // parseCsvLine が SyntaxError を投げる（引用符の閉じ忘れ等）のは想定内だが、
      // 予期しない例外（TypeError 等）はサーバーログに記録して握り潰さない (CLAUDE.md §6)。
      if (!(err instanceof SyntaxError)) {
        console.error(`[importTickets] 行 ${rowNum} の CSV パースで予期しないエラー:`, err);
      }
      // SyntaxError は書式エラー用メッセージ、予期しない例外は汎用メッセージを積む
      // (TypeError 等に「引用符が閉じられていない」は誤誘導になるため分岐する)
      errors.push({
        row: rowNum,
        message:
          err instanceof SyntaxError
            ? 'CSV の形式が正しくありません（引用符が閉じられていない可能性があります）'
            : 'CSV の読み取りに失敗しました。ファイルの内容を確認してください。',
      });
      continue;
    }

    // セルのバリデーション・型変換を純粋関数に委譲する (責務の分離)
    const validation = validateImportRow(cells, columnIndices, mode, now);
    if (!validation.ok) {
      // バリデーションエラーを行番号付きで記録してこの行をスキップする
      errors.push({ row: rowNum, message: validation.message });
      continue;
    }
    // バリデーション通過: 検証済みデータを展開する
    const {
      title,
      body,
      priority,
      resolutionDueAt,
      createdAt: parsedCreatedAt,
      locationName,
      categoryName,
      status: parsedStatus,
      assigneeName,
      creatorName,
    } = validation.data;
    // 「状況」列が未指定 (null) ならモードの既定初期ステータスにフォールバックする
    const status = parsedStatus ?? initialStatus;
    // §3.1 フォローアップ: 完了系ステータス (Lite: Closed/Resolved, Pro: Resolved) で起票する場合、
    // インポート時刻を解決日時として記録する (update-ticket.ts の完了判定と同じ getCompletionStatuses
    // を共有し、「完了」の定義が呼び出し箇所ごとに食い違わないようにする)
    const resolvedAt = getCompletionStatuses(mode).includes(status) ? now : null;
    // フォローアップ (2026-07-13): 「状況」列がモードの初期状態 (Lite: 未対応 / Pro: 新規) 以外を
    // 指定していた場合、その行は既に着手済み (対応中・完了等) であり、実運用の Excel 台帳では
    // 既にエージェントの初回対応が済んでいたはずである。CSV には応答者・応答日時の列が無いため
    // インポート時刻で近似する (resolvedAt と同じ「正確な履歴が無いので取り込み時刻で代替する」方針)。
    // これを設定しないと、Pro モードの SLA バッジ・品質メトリクス (平均初回応答時間) が
    // インポートされた履歴チケットを永久に「未応答」として扱ってしまう (§2.1.2 と同種の欠落)。
    // /code-review ultra 指摘対応 (2026-07-13): 判定ロジックを ticket-status.ts の
    // hasRespondedByImportStatus に抽出し、getCompletionStatuses と同じくドメイン層を唯一の源にした
    const firstRespondedAt = hasRespondedByImportStatus(status, mode) ? now : null;
    // フォローアップ (2026-07-15 #3): 「起票日時」列が指定されていればその値、無ければ従来どおり
    // インポート時刻 (now) を起票日時として使う。resolvedAt/firstRespondedAt は引き続き
    // インポート時刻で近似する (正確な履歴が無いため) が、起票日時が過去日の場合でも
    // 「解決済み/応答済み日時が起票日時より前」にはならない (validateImportRow が起票日時を
    // now 以前に制限しているため、resolvedAt/firstRespondedAt=now は常に rowCreatedAt 以降になる)
    const rowCreatedAt = parsedCreatedAt ?? now;

    // 拠点名が指定されていれば ID に解決する (resolveNameToId を共有)。テナントに存在しない
    // 拠点名はタイポや削除済み拠点の可能性が高く、無言で「拠点未設定」にすると取り込んだデータの
    // 拠点情報が消えたことに気づけないため、エラー行として記録する。
    let locationId: string | null = null;
    if (locationName !== null) {
      const resolved = resolveNameToId(locationName, locationsByName, '拠点');
      if (!resolved.ok) {
        errors.push({ row: rowNum, message: resolved.message });
        continue;
      }
      locationId = resolved.id;
    }

    // カテゴリ名が指定されていれば ID に解決する (resolveNameToId を共有。フォローアップ
    // 2026-07-11)。ただしカテゴリは拠点と異なり Pro モード専用の概念であり、Lite テナントでは
    // categoriesByName を意図的に空のまま保つ (上のマップ構築を参照)。そのため Lite では
    // 「カテゴリ」列に値があっても解決を試みず null のまま起票する
    // (Web フォーム/メール/LINE 取り込みの他の全経路と同じく categoryId は常に null)。
    let categoryId: string | null = null;
    if (categoryName !== null && mode !== 'lite') {
      const resolved = resolveNameToId(categoryName, categoriesByName, 'カテゴリ');
      if (!resolved.ok) {
        errors.push({ row: rowNum, message: resolved.message });
        continue;
      }
      categoryId = resolved.id;
    }

    // フォローアップ (2026-07-13): 担当者名が指定されていれば ID に解決する (resolveNameToId を
    // 共有)。拠点と同じく Lite/Pro 両モードで使える概念のため mode によるガードは行わない。
    // テナントに存在しない担当者名はタイポや退職済みメンバーの可能性が高く、無言で「未アサイン」
    // にすると取り込んだデータの担当者情報が消えたことに気づけないため、エラー行として記録する。
    let assigneeId: string | null = null;
    if (assigneeName !== null) {
      // /code-review ultra 指摘対応 (2026-07-13): 同姓同名のエージェントが複数存在する場合、
      // Map のキー衝突でどちらか一方へ無言で misassign されてしまう (拠点/カテゴリの誤りより
      // 「チケットの所有権を誤らせる」ため深刻)。resolveOwnedName が重複検出を先に行う。
      const resolved = resolveOwnedName(
        assigneeName,
        agentsByName,
        duplicateAgentNames,
        '担当者',
        'エージェント',
        '担当者を設定してください',
      );
      if (!resolved.ok) {
        errors.push({ row: rowNum, message: resolved.message });
        continue;
      }
      assigneeId = resolved.id;
    }

    // フォローアップ (2026-07-14): 監査で発見したギャップの解消。起票者名が指定されていれば ID に
    // 解決する (resolveNameToId を共有)。担当者と同じく Lite/Pro 両モードで使える概念のため mode
    // によるガードは行わない。列が無い/セルが空の場合は既定どおりインポート実行者を起票者にする
    // (後方互換: 従来の CSV フォーマットのままインポートしても壊れない)。
    // 起票者はチケットの閲覧権限 (依頼者は自分の起票したチケットしか見えない。
    // src/app/(app)/tickets/[id]/page.tsx) と通知の宛先 (update-ticket.ts) の両方を左右するため、
    // 担当者と同じく無言で「インポート実行者に付け替え」ず、解決できない名前はエラー行として記録する。
    let effectiveCreatorId = creatorId;
    if (creatorName !== null) {
      // 担当者と同じ理由 (同姓同名の misassign 防止) で resolveOwnedName が重複検出を先に行う
      const resolved = resolveOwnedName(
        creatorName,
        usersByName,
        duplicateCreatorNames,
        '起票者',
        'メンバー',
        '起票者を確認してください',
      );
      if (!resolved.ok) {
        errors.push({ row: rowNum, message: resolved.message });
        continue;
      }
      effectiveCreatorId = resolved.id;
    }

    // Phase 4 課金: 残枠を使い切っていたらこの行以降は起票せずエラーとして記録する
    // (Web フォーム / メール / LINE 取り込みと同じ上限を CSV インポートにも適用する)
    if (quota.limited && quota.remaining <= 0) {
      errors.push({
        row: rowNum,
        message: `月間の問い合わせ件数が上限 (${quota.limit} 件) に達したため取り込めませんでした。プランをアップグレードしてください。`,
      });
      continue;
    }

    // チケットを 1 件作成する (失敗してもループを続けて部分成功を許可する)
    try {
      // リポジトリ経由でチケットを DB に保存する
      await repos.tickets.create({
        title, // 件名
        body, // 本文 (空文字も許容)
        priority, // 優先度
        // 「カテゴリ」列があれば名前解決済みの ID、無ければ未分類 (null。後から設定できる)
        categoryId,
        // フォローアップ (2026-07-14): 「起票者」列があれば名前解決済みの ID、無ければ従来どおり
        // インポート実行者 (セッションのユーザー) が起票者になる
        creatorId: effectiveCreatorId,
        tenantId, // テナントスコープを必ず付与する (クロステナント防止)
        // 「状況」列があればその値、無ければモードの既定初期ステータス (Lite: Open / Pro: New)
        status,
        // 解決期限: Lite は「期限日」列の手動値 (無指定なら null。依頼者が期日を指定しない
        // 履歴データの取り込みを許容する既存挙動)。Pro は「期限日」列を上の分岐で無視している
        // ため (手動上書きの経路が無い設計)、route.ts の Web フォーム起票と同じく優先度・起票日時
        // から常に自動算出する (フォローアップ 2026-07-15 #3: 無しでは Pro の CSV インポート行だけ
        // 解決期限が永久に null のままになり、SLA バッジ・ダッシュボードの SLA 超過集計に乗らない)
        resolutionDueAt:
          mode === 'pro' ? calculateResolutionDueAt(priority, rowCreatedAt) : resolutionDueAt,
        // 初回応答期限: CSV に対応列が無いため、常に優先度ベースで自動算出する
        // (Web フォーム・メール・LINE 取り込みと同じ SLA ヘルパーを使う)。フォローアップ
        // (2026-07-15 #3): 基準時刻は rowCreatedAt (「起票日時」列があればその値、無ければ now) を使う。
        // now 固定のままだと、過去日で起票日時を指定した行の初回応答期限が実際の起票日から
        // 大きくズレる (例: 半年前の起票を再現しても「今から 4 時間後」が期限になってしまう)
        firstResponseDueAt: calculateFirstResponseDueAt(priority, rowCreatedAt),
        locationId, // 拠点 ID (「拠点」列があれば名前解決済み、無ければ null)
        // フォローアップ (2026-07-13): 担当者 ID (「担当者」列があれば名前解決済み、無ければ未アサイン)
        assigneeId,
        // §3.1 フォローアップ: 完了系ステータスで起票する場合はインポート時刻を解決日時にする
        resolvedAt,
        // フォローアップ (2026-07-13): 初期状態以外で起票する場合はインポート時刻を初回応答日時にする
        firstRespondedAt,
        // /code-review ultra 指摘対応 (2026-07-13): 作成日時を明示的に揃える (DB 既定の実 INSERT
        // 時刻に任せない)。フォローアップ (2026-07-15 #3): 「起票日時」列があればその値
        // (rowCreatedAt)、無ければ従来どおり取り込み時刻 (now) を使う。resolvedAt/firstRespondedAt
        // (どちらも now) は validateImportRow が起票日時を now 以前に制限しているため、
        // rowCreatedAt より前になることはなく品質メトリクスの平均時間が負値になる回帰は起きない
        createdAt: rowCreatedAt,
      });
      // 成功カウンタをインクリメント
      imported += 1;
      // フォローアップ (2026-07-13): 担当者が割り当てられた行はエージェント別に集計しておく
      // (通知はインポート後にまとめて 1 通ずつ送る)
      if (assigneeId) {
        assignedCounts.set(assigneeId, (assignedCounts.get(assigneeId) ?? 0) + 1);
      }
      // 上限のあるプランでは残枠を消費する (無制限プランは remaining が Infinity のため減算不要だが、
      // 明示的にガードして意図を示す)
      if (quota.limited) quota.remaining -= 1;
    } catch (err) {
      // 内部エラー (Prisma 例外等) をサーバーログに記録する (スキーマ情報の漏洩防止のため UI には返さない)
      console.error(`[importTickets] 行 ${rowNum} のチケット作成に失敗:`, err);
      // ユーザーには汎用メッセージのみ返す (Prisma のエラー詳細をフロントに漏らさない)
      errors.push({
        row: rowNum,
        message: 'チケットの作成に失敗しました。内容を確認してください。',
      });
    }
  }

  // インポートでチケットが 1 件以上作成された場合のコミット後処理
  if (imported > 0) {
    // チケット一覧と管理ダッシュボードのキャッシュを無効化する
    // /dashboard も対象にしないと、インポート後もカウントが旧値のまま最大 60 秒間表示され続ける
    revalidatePath('/tickets');
    revalidatePath('/dashboard');

    // Phase 4: 新規起票を Slack/Teams/Chatwork へ通知する (Web フォーム・メール・LINE と同じ経路)。
    // CSV は 1 回で最大 MAX_ROWS 件を作成しうるため、他チャネルと違いチケットごとには送らず、
    // 件数をまとめた 1 通にする (アプリ内通知と同じ「まとめて 1 通」方針。200 件でも通知は 1 通)。
    // ベース URL 解決・送信・失敗時のベストエフォートログは共通ヘルパーに集約する (§6 DRY)
    await notifyOutboundBestEffort(
      tenantId,
      (baseUrl) => ({
        subject: `CSV インポートで${imported}件の問い合わせが追加されました`, // 通知の見出し (件数を含める)
        body: `一覧から内容を確認してください。`, // 個々のチケット内容は含めず一覧への導線のみ示す
        ticketUrl: `${baseUrl}/tickets`, // 単一チケットに紐づかないため一覧ページへリンクする
      }),
      '[importTickets]',
    );

    // 同テナントの他エージェント (インポート実行者を除く) に一括追加を通知する。
    // 個別チケットごとではなく 1 通にまとめることで通知の過多を防ぐ (200 件追加でも通知は 1 通)。
    // /code-review ultra 指摘対応 (2026-07-13): 「担当者」列の名前解決で既に取得済みの場合は
    // それを再利用し、同一リクエスト内で listAgents を二重に呼ばないようにする (§8 パフォーマンス)
    const agents = agentsForAssignee ?? (await repos.users.listAgents(tenantId));
    // インポート実行者自身への通知は不要なので除外する (自分が実施したことは知っているため)
    const otherAgentIds = agents.map((a) => a.id).filter((id) => id !== creatorId);

    // フォローアップ (2026-07-13): 監査で発見したギャップの解消。「担当者」列で割り当てた
    // エージェントには、上の「N件のチケットが追加されました」という全エージェント向けの汎用通知
    // だけでは「自分が担当することになった」ことが伝わらない。updateTicketAssignee (画面からの
    // 手動アサイン) が担当者へ 'assigned' 通知を送るのと同じ意図で、担当者ごとに 1 通ずつ
    // (行ごとではなく) まとめて通知する (200 件でも担当者数分の通知で済む)。
    // インポート実行者自身が自分を担当に設定した場合は、既にそれを知っているため対象外にする
    // (上の otherAgentIds と同じ「自分の操作を自分に通知しない」方針)。
    const assignedAgentIds = [...assignedCounts.keys()].filter((id) => id !== creatorId);

    // /code-review ultra 指摘対応 (2026-07-13): 上記 2 種類の通知は互いに独立した宛先・内容の
    // I/O であり、notifyImportBatch 共通ヘルパーへの抽出と合わせて Promise.all で並行実行する
    // (§8 パフォーマンス)。フォローアップ (2026-07-13): 監査で発見したギャップの解消。担当割当は
    // 手動アサインと同じくメールも送る (notifyAssignedAgentsByEmail) ので、これも独立した I/O として
    // 同じ Promise.all に加える
    await Promise.all([
      notifyImportBatch(
        otherAgentIds,
        tenantId,
        'imported', // CSV 一括インポート通知 (NotificationType.imported)
        () => `${imported} 件のチケットが CSV インポートで追加されました`,
        '[importTickets] 一括追加通知',
      ),
      notifyImportBatch(
        assignedAgentIds,
        tenantId,
        'assigned', // 担当割当通知 (NotificationType.assigned)
        (agentId) =>
          `CSV インポートで ${assignedCounts.get(agentId)} 件のチケットが担当者に割り当てられました`,
        '[importTickets] 担当割当通知',
      ),
      notifyAssignedAgentsByEmail(assignedAgentIds, tenantId, assignedCounts),
    ]);
  }

  // 成功件数とエラー一覧を返す
  return { imported, errors };
}
