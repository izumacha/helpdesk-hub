/**
 * Comment notification fan-out target resolution (shared helper).
 *
 * 「コメント (返信) が付いたとき、誰にアプリ内通知を送るか」を 1 か所に集約した純粋寄りのヘルパー。
 * Web フォーム経由のコメント投稿 (POST /api/tickets/[id]/comments) と、メール取り込みの
 * スレッド継続 (POST /api/inbound/email でのコメント追記 / Phase 2) の両方から再利用する (DRY)。
 *
 * 宛先の方針:
 *  - 担当者/エージェントがコメント → 依頼者 (起票者) + 担当者が居れば担当者。
 *  - 依頼者がコメントし担当者が決まっている → その担当者のみ。
 *  - 依頼者がコメントし担当者未定 → テナント内の全エージェント。
 * いずれもコメント投稿者自身は除外し、テナント内のユーザーだけを対象にする (クロステナント遮断 §9)。
 */

// リポジトリ束 (テナント内エージェント ID の取得に使用)
import { repos } from '@/data';

// コメント通知の送信先ユーザー ID 群を決定する (テナントスコープ)
export async function resolveCommentRecipients(
  ticket: { creatorId: string; assigneeId: string | null }, // 対象チケットの起票者/担当者
  authorId: string, // コメントを書いたユーザー
  authorIsAgent: boolean, // 書き手がエージェント/管理者か
  tenantId: string, // 当該テナント (全エージェント取得のスコープ)
): Promise<string[]> {
  // 宛先候補を集める配列
  const candidates: string[] = [];
  // エージェントがコメントした場合: 依頼者 (+ 担当者が居れば担当者)
  if (authorIsAgent) {
    candidates.push(ticket.creatorId);
    if (ticket.assigneeId) candidates.push(ticket.assigneeId);
  } else if (ticket.assigneeId) {
    // 依頼者がコメントし担当者が決まっている場合は担当者のみ
    candidates.push(ticket.assigneeId);
  } else {
    // 依頼者がコメントし担当者未定なら全エージェントに通知 (テナント内のみ)
    candidates.push(...(await repos.users.listAgentIds(tenantId)));
  }
  // 重複排除し、コメント投稿者自身は除外して返す
  return Array.from(new Set(candidates)).filter((id) => id !== authorId);
}
