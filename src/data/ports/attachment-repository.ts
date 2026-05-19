// ドメイン型 (添付ファイル) を取り込む
import type { Attachment, AttachmentStorageKind } from '@/domain/attachment';

// 添付メタデータの永続化を抽象化したリポジトリ契約 (Port)。
// 全メソッドの取得/削除系は tenantId 必須化済。他テナントの ID は問答無用で null/no-op。

// create に渡す入力値 (id / createdAt はアダプタ側で採番する)
export interface CreateAttachmentInput {
  ticketId: string; // 親チケット ID (必須)
  commentId: string | null; // 紐づくコメント ID (チケット本体添付は null)
  uploaderId: string; // アップロード実行者
  tenantId: string; // 所属テナント (where に必ず注入する)
  mimeType: string; // 検証通過済みの MIME (例: image/jpeg)
  size: number; // バイト数
  originalName: string; // 元ファイル名
  storageKey: string; // 保存先キー (StoragePort に書き込んだキーと同じ)
  storage: AttachmentStorageKind; // 保存方式 (現状 'local')
}

// 添付メタデータ用リポジトリの契約
//
// 注意: `delete` および DB の ON DELETE CASCADE は **メタデータしか消さない**。
// 物理ファイル (StoragePort 配下) を消したい場合は、呼び出し側で以下のシーケンスを守ること:
//   1. `listByTicket` / `findById` で削除対象の `storageKey` を取得する
//   2. DB を削除する (リポジトリ or Ticket/Tenant の cascade)
//   3. `storage.delete(storageKey)` を best-effort で呼ぶ
// 削除 UI / 削除 Service を実装する際に上記のラッパーを 1 箇所に集約することで、
// var/uploads/ に孤児ファイルが残らないようにする (Phase 2 以降の課題)。
export interface AttachmentRepository {
  // 1 件作成 (StoragePort.put 成功後にメタを保存する用途)
  create(input: CreateAttachmentInput): Promise<Attachment>;
  // ID + tenantId で 1 件取得 (配信時の権限チェック用)。他テナントの ID は null を返す
  findById(id: string, tenantId: string): Promise<Attachment | null>;
  // チケット ID + tenantId で添付一覧を取得 (古い順)。詳細ページのサムネ表示用
  listByTicket(ticketId: string, tenantId: string): Promise<Attachment[]>;
  // チケットに紐づく添付の件数を返す (5 枚上限チェック用)
  countByTicket(ticketId: string, tenantId: string): Promise<number>;
  // ID + tenantId で 1 件削除 (StoragePort.delete のロールバック相互運用に使う)。
  // 物理ファイルは別途 storage.delete を呼ぶこと
  delete(id: string, tenantId: string): Promise<void>;
}
