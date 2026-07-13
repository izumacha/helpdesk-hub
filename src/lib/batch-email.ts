// 複数の宛先へ同種のメールをベストエフォートで送る共通ヘルパー。
//
// /code-review ultra 指摘対応 (2026-07-13): エスカレーション一斉メール (update-ticket.ts の
// escalateTicket) と CSV インポートの担当割当メール (import-tickets.ts の
// notifyAssignedAgentsByEmail) が、それぞれ「id→email を解決したエージェント一覧へ
// Promise.allSettled で送信し、失敗件数をログに残す」という同型の処理を個別実装しており
// 2 箇所目の重複になっていた (CLAUDE.md §6 DRY: 「実際に 2〜3 箇所目で重複したら共通化する」)。
// 1 件の送信失敗が他の宛先への送信をブロックしないよう Promise.allSettled を使い、失敗件数のみを
// ログに残す (誰が失敗したかの詳細まで欲しい場合は呼び出し側で個別にラップする)。

// 設定された EmailSender (console / smtp) を取得するファクトリ
import { getEmailSender } from '@/lib/email';

// 送信先として最低限必要な情報 (呼び出し側の型がこれを満たしていればそのまま渡せる)
export interface BatchEmailRecipient {
  id: string; // ログ・呼び出し側の突き合わせ用 (このヘルパー自体は使わない)
  email: string; // 送信先メールアドレス
}

// 宛先ごとにメール本文を組み立てる関数。全員へ同一内容を送る場合は引数を無視してよい
// (escalateTicket のように全員同じ文面の場合と、notifyAssignedAgentsByEmail のように
// 宛先ごとに件数が異なる場合の両方に対応する)。
export type RenderBatchEmail<R> = (recipient: R) => { subject: string; text: string; html: string };

// recipients が空なら何もしない。各宛先への送信は並列に行い、1 件の失敗が他をブロックしない。
export async function sendBatchEmail<R extends BatchEmailRecipient>(
  recipients: R[],
  renderEmail: RenderBatchEmail<R>,
  logPrefix: string, // 失敗ログの先頭に付ける識別子 (例: '[escalateTicket]')
): Promise<void> {
  // 対象が居なければ何もしない (早期リターン)
  if (recipients.length === 0) return;
  // 各宛先への送信を並列で行う。Promise.allSettled を使い、1 件の送信失敗が
  // 他の宛先への送信をブロックしないようにする
  const results = await Promise.allSettled(
    recipients.map((recipient) => {
      const { subject, text, html } = renderEmail(recipient);
      return getEmailSender().send({ to: recipient.email, subject, text, html });
    }),
  );
  // 失敗した送信件数をサーバーログに記録する (CLAUDE.md §6: エラーを握り潰さない)
  const failedCount = results.filter((r) => r.status === 'rejected').length;
  if (failedCount > 0) {
    console.warn(`${logPrefix} ${failedCount} 件のメール送信に失敗しました`);
  }
}
