// 隔離記録 (QuarantinedEmail) への記録を共通化するヘルパー。
//
// /code-review ultra 指摘対応 (2026-07-13): メール取り込み (POST /api/inbound/email) と
// LINE 取り込み (POST /api/inbound/line) それぞれの Route Handler が「repos.quarantinedEmails.record
// を try/catch で囲み、書き込み失敗はログに残すだけで本来の応答 (隔離判定) には影響させない」という
// 同型のラッパーを個別実装しており 2 箇所目の重複になっていた。src/lib/settings-audit.ts の
// recordSettingsAudit が全く同じ理由 (「記録失敗が本来の処理に影響してはいけない」書き込みの複製)
// で共通化された前例に倣い、ここに集約する (§6 DRY)。
//
// フォローアップ (2026-07-21): 監査で発見したギャップ。隔離記録は §3.2 で永続化・admin 向け
// 一覧画面まで実装したが、隔離が発生したこと自体を admin に知らせる手段が無く、成功して起票された
// 'imported' 通知だけが届く非対称な状態だった (§3.5 のメール取り込み通知と同じ問題意識)。
// ここに「テナントあたり一定間隔で 1 回だけ admin へ通知する」ロジックを追加する。

// データ層の Composition Root (Prisma 直叩きを避ける)
import { repos } from '@/data';
// 隔離記録の入力型 (channel で判別されるユニオン。メール/LINE それぞれの必須フィールドを強制する)
import type { RecordQuarantinedEmailInput } from '@/data/ports/quarantined-email-repository';
// バッチ通知の共有ヘルパー (§6 DRY: import-tickets.ts の notifyImportBatch を抽出したもの)
import { notifyUsersBatch } from '@/features/notifications/notify';

// 隔離通知の最短送信間隔 (24時間)。スパム流入等で短時間に大量の隔離が発生しても、
// テナントあたりこの間隔に 1 回しか admin へ通知しない (通知の連投による自己 DoS を防ぐ。
// 個々の隔離記録自体は §3.2 の /quarantine 画面で漏れなく確認できるため、通知は
// 「気づくきっかけ」を提供すれば足りる)
const QUARANTINE_NOTIFY_INTERVAL_MS = 24 * 60 * 60 * 1000;

// 隔離記録を 1 件保存する。呼び出し元が既に「起票せず隔離する」と判断した後に呼ぶこと。
// 記録自体が失敗してもログに残すだけで、呼び出し元の応答 (202/200 等) には一切影響させない
// (recordSettingsAudit と同じ「非クリティカルな副作用」の扱い方)
export async function recordQuarantineSafe(
  input: RecordQuarantinedEmailInput,
  logPrefix: string, // 記録失敗時のログ接頭辞 (呼び出し元を識別するため。例: '[POST /api/inbound/email]')
): Promise<void> {
  let recorded = true;
  try {
    await repos.quarantinedEmails.record(input);
  } catch (err) {
    // 記録自体の失敗は本来の処理の成否に影響させず、ログに残すだけに留める
    recorded = false;
    console.error(`${logPrefix} 隔離記録の保存に失敗しました`, err);
  }
  // 記録できた場合のみ通知を試みる (記録に失敗した隔離を「確認してください」と案内しても
  // /quarantine 画面には何も表示されず利用者を混乱させるだけのため)
  if (recorded) {
    await notifyAdminsOfQuarantineSafe(input.tenantId, logPrefix);
  }
}

// 隔離発生をテナントの admin 全員へ通知する (ベストエフォート・スロットリング付き)。
// 失敗しても呼び出し元 (recordQuarantineSafe) の処理には一切影響させない
async function notifyAdminsOfQuarantineSafe(tenantId: string, logPrefix: string): Promise<void> {
  try {
    const now = new Date();
    // 原子的なゲート: 直近 QUARANTINE_NOTIFY_INTERVAL_MS 以内に既に通知済みなら false が返り、
    // このリクエストは通知を送らない (read-then-write ではなく単一の updateMany で判定するため、
    // 同時に大量の隔離が発生してもレースで二重送信しない)
    const shouldNotify = await repos.tenants.updateQuarantineNotifiedAt(
      tenantId,
      now,
      QUARANTINE_NOTIFY_INTERVAL_MS,
    );
    if (!shouldNotify) return;

    try {
      // 通知先は admin のみ (§3.2 フォローアップ再訪で /quarantine 画面自体が admin 専用のため)
      const admins = await repos.users.listAdminEmails(tenantId);
      await notifyUsersBatch(
        admins.map((a) => a.id),
        tenantId,
        'quarantined',
        () => '確認が必要な隔離メールがあります。「隔離メール」画面をご確認ください。',
        logPrefix,
      );
    } catch (err) {
      // 通知の権利は既にクレーム済み (updateQuarantineNotifiedAt が true を返した) だが、
      // 実際の送信 (admin 一覧取得 or notifyUsersBatch) に失敗した。クレームしたまま放置すると
      // 1 件も届いていないのに次の隔離発生から最大 24 時間、誰にも通知が届かなくなってしまう
      // (trial-reminders/route.ts が「送信成功後にのみ冪等化フラグを更新する」のと同じ問題意識。
      // ただしこちらは同時多発する隔離イベント間の二重送信レースを防ぐため、送信前に原子的な
      // クレームを取る設計を維持しつつ、失敗時だけクレームを解除して次回の再送を可能にする)。
      // 解除自体が失敗しても外側の catch に落ちてログに残るだけなので、呼び出し元には影響しない
      await repos.tenants.clearQuarantineNotifiedAt(tenantId);
      throw err;
    }
  } catch (err) {
    // 通知の失敗は隔離記録自体の成否に影響させず、ログに残すだけに留める
    console.error(`${logPrefix} 隔離通知の送信に失敗しました`, err);
  }
}
