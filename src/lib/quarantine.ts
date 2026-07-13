// 隔離記録 (QuarantinedEmail) への記録を共通化するヘルパー。
//
// /code-review ultra 指摘対応 (2026-07-13): メール取り込み (POST /api/inbound/email) と
// LINE 取り込み (POST /api/inbound/line) それぞれの Route Handler が「repos.quarantinedEmails.record
// を try/catch で囲み、書き込み失敗はログに残すだけで本来の応答 (隔離判定) には影響させない」という
// 同型のラッパーを個別実装しており 2 箇所目の重複になっていた。src/lib/settings-audit.ts の
// recordSettingsAudit が全く同じ理由 (「記録失敗が本来の処理に影響してはいけない」書き込みの複製)
// で共通化された前例に倣い、ここに集約する (§6 DRY)。

// データ層の Composition Root (Prisma 直叩きを避ける)
import { repos } from '@/data';
// 隔離記録の入力型 (channel で判別されるユニオン。メール/LINE それぞれの必須フィールドを強制する)
import type { RecordQuarantinedEmailInput } from '@/data/ports/quarantined-email-repository';

// 隔離記録を 1 件保存する。呼び出し元が既に「起票せず隔離する」と判断した後に呼ぶこと。
// 記録自体が失敗してもログに残すだけで、呼び出し元の応答 (202/200 等) には一切影響させない
// (recordSettingsAudit と同じ「非クリティカルな副作用」の扱い方)
export async function recordQuarantineSafe(
  input: RecordQuarantinedEmailInput,
  logPrefix: string, // 記録失敗時のログ接頭辞 (呼び出し元を識別するため。例: '[POST /api/inbound/email]')
): Promise<void> {
  try {
    await repos.quarantinedEmails.record(input);
  } catch (err) {
    // 記録自体の失敗は本来の処理の成否に影響させず、ログに残すだけに留める
    console.error(`${logPrefix} 隔離記録の保存に失敗しました`, err);
  }
}
