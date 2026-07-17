// 検証済み添付ファイル群をストレージへ書き込み、メタ情報を DB へ INSERT する共通ヘルパー。
//
// /code-review ultra 指摘対応 (2026-07-13): POST /api/tickets (新規チケット添付)・
// POST /api/tickets/[id]/comments (コメント添付)・POST /api/inbound/email (メール取り込みの
// 新規起票/スレッド追記添付) の 3 箇所が「ストレージ書き込み → メタ INSERT」「失敗時は
// 書き込み済みキーを best-effort で削除」という同型の処理をそれぞれ個別に実装しており、
// 3 箇所目の重複になっていた (CLAUDE.md §6 DRY: 「実際に 2〜3 箇所目で重複したら共通化する」)。
// 既存 2 箇所は削除ログのレベル (console.error / console.warn) が食い違っていたため、
// この共通化にあわせて「ロールバック失敗は警告ではなく本物のエラー」という POST /api/tickets の
// 方針 (より慎重に検討された判断) に統一した。

// crypto ベースの UUID 生成 (保存先キー組み立て用)
import { randomUUID } from 'node:crypto';
// 添付ファイル本体の StoragePort (Edge runtime 汚染回避のため別モジュールから取り込む)
import { storage } from '@/data/storage';
// MIME → 拡張子の対応表 (storageKey の組み立てで使用) / チケット当たりの添付総数上限
import { MAX_ATTACHMENTS_PER_TICKET, MIME_TO_EXTENSION } from '@/domain/attachment';
// 検証済み添付ファイルの型
import type { ValidatedAttachment } from '@/lib/validations/attachment';
// リポジトリ束の型 (トランザクション内 tx / 非トランザクション repos 共通)
import type { Repos } from '@/data/ports/unit-of-work';

// チケット当たりの添付総数上限チェックの結果 (超過時のみ日本語メッセージを持つ)
export type TicketAttachmentQuotaCheck = { ok: true } | { ok: false; message: string };

// 指定チケットに今回のファイル群を追加しても、チケット当たりの添付総数上限
// (MAX_ATTACHMENTS_PER_TICKET) を超えないかを判定する。
// POST /api/tickets/[id]/comments (コメント添付) と POST /api/inbound/email (メールスレッド
// 継続の添付) の両方が同じ判定を使うための共通ヘルパー (§6 DRY)。
//
// checkAttachmentQuota (tenant-plan.ts、テナント累計バイト数の上限) と同じく best-effort な
// check-then-act であり、DB レベルの原子性は持たない (同時並行アップロードでは合計が上限を
// わずかに超えうる)。1 回のリクエスト内の件数上限は MAX_ATTACHMENTS_PER_UPLOAD が担うため、
// ここでは「チケットに既に保存済みの件数 + 今回追加分」の生涯合計だけを見る。
export async function checkTicketAttachmentQuota(
  repos: Pick<Repos, 'attachments'>,
  ticketId: string,
  tenantId: string,
  newFilesCount: number,
): Promise<TicketAttachmentQuotaCheck> {
  // 追加分が無ければ DB 集計を行わず即座に許可する (不要なクエリを避ける)
  if (newFilesCount <= 0) return { ok: true };
  // このチケットに既に保存済みの添付件数をテナントスコープで数える
  const existingCount = await repos.attachments.countByTicket(ticketId, tenantId);
  // 既存件数 + 今回追加分が上限を超えるなら拒否する
  if (existingCount + newFilesCount > MAX_ATTACHMENTS_PER_TICKET) {
    return {
      ok: false,
      message: `1件の問い合わせに添付できるファイルは合計${MAX_ATTACHMENTS_PER_TICKET}件までです`,
    };
  }
  // 上限内なので許可
  return { ok: true };
}

// 検証済み添付ファイル群を 1 件ずつ「ストレージ書き込み → メタ INSERT」の順に処理する。
// 必ずトランザクション内 (tx) で呼び、書き込み済みストレージキーを writtenKeys に積むこと。
// ストレージへの書き込みは DB トランザクション外で観測できる副作用のため、呼び出し元が
// トランザクション失敗時に writtenKeys を使って best-effort でロールバック (削除) する。
export async function persistAttachments(
  tx: Repos,
  files: ValidatedAttachment[],
  ticketId: string,
  commentId: string | null, // 新規チケットへの添付なら null、コメントへの添付なら該当コメント ID
  uploaderId: string,
  tenantId: string,
  writtenKeys: string[],
): Promise<void> {
  for (const v of files) {
    // 保存先キーを組み立てる (例: tenantId/ticketId/<uuid>.jpg)
    const ext = MIME_TO_EXTENSION[v.mimeType];
    const key = `${tenantId}/${ticketId}/${randomUUID()}.${ext}`;
    // File 本体のバイト列を ArrayBuffer 経由で Uint8Array に変換する
    const buf = new Uint8Array(await v.file.arrayBuffer());
    // ストレージへ書き込む (失敗時は呼び出し元が uow のロールバックと writtenKeys で後始末する)
    await storage.put(key, buf, { contentType: v.mimeType, size: v.size });
    writtenKeys.push(key);
    // メタ情報を DB に保存する (storage="local" 固定)
    await tx.attachments.create({
      ticketId,
      commentId,
      uploaderId,
      tenantId,
      mimeType: v.mimeType,
      size: v.size,
      originalName: v.originalName,
      storageKey: key,
      storage: 'local',
    });
  }
}

// 添付ファイルのストレージ書き込みに失敗した (または DB ロールバックで無関係になった) 際の
// 後始末 (best-effort)。既に書き込み済みのファイルを個別に削除する。
export async function cleanupWrittenAttachments(
  writtenKeys: string[],
  logPrefix: string,
): Promise<void> {
  await Promise.all(
    writtenKeys.map((key) =>
      storage.delete(key).catch((cleanupErr) => {
        // ストレージ削除失敗はエラーとしてログに残す (warn ではなく error: ロールバック失敗は本物のエラー)
        console.error(`${logPrefix} failed to clean up storage`, { key, cleanupErr });
      }),
    ),
  );
}
