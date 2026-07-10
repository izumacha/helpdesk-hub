// 設定変更監査ログ (SettingsAuditLog) への記録を共通化するヘルパー。
// §4.2 で SSO/LINE/通知チャネルの 3 アクション向けに導入した「try/catch で囲み、
// 書き込み失敗はログに残すだけで本来の操作の成否には影響させない」という定型コードが、
// §4.3 でテナントモード・拠点 CRUD・転送先アドレス再発行の 5 アクションを追加した結果
// 10 箇所に複製される状態になったため (§6 DRY: 2〜3 箇所目で共通化する閾値を大きく超過)、
// ここに集約する。

// データ層の Composition Root (Prisma 直叩きを避ける)
import { repos } from '@/data';
// 設定変更監査ログの対象アクション種別
import type { SettingsAuditAction } from '@/domain/types';

// 設定変更 1 件を監査ログに記録する。呼び出し元の操作 (SSO/LINE/通知チャネル設定の更新・
// テナントモード切替・拠点 CRUD・転送先アドレス再発行) が既に成功した後に呼ぶこと。
// 記録自体が失敗してもログに残すだけで、呼び出し元の操作結果には一切影響させない
// (update-ticket.ts の外部通知失敗時と同じ「非クリティカルな副作用」の扱い方)
export async function recordSettingsAudit(input: {
  tenantId: string; // 対象テナント (セッション由来のみを渡すこと。クロステナント防止)
  // 操作を行ったユーザー ID。§4.3 フォローアップ (2026-07-10): Stripe Webhook 起因の自動プラン
  // ダウングレードのようにユーザーが介在しないシステム操作を記録する場合は null を渡す
  // (SettingsAuditLogWithRefs.actorName が固定のシステムラベルに解決する)
  actorId: string | null;
  action: SettingsAuditAction; // 実行された操作の種別
  logPrefix: string; // 記録失敗時のログ接頭辞 (呼び出し元を識別するため。例: '[create-location]')
}): Promise<void> {
  try {
    // 監査ログテーブルへ 1 件書き込む
    await repos.settingsAudit.record({
      tenantId: input.tenantId,
      actorId: input.actorId,
      action: input.action,
    });
  } catch (err) {
    // 記録自体の失敗は本来の操作の成否に影響させず、ログに残すだけに留める
    console.error(`${input.logPrefix} 監査ログの記録に失敗しました:`, err);
  }
}
