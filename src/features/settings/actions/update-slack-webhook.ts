'use server';

// Next.js のキャッシュ無効化 (設定ページの再レンダリングに使う)
import { revalidatePath } from 'next/cache';
// 現在のセッション取得
import { auth } from '@/lib/auth';
// テナントリポジトリ
import { repos } from '@/data';
// URL バリデーション用 Zod スキーマ
import { z } from 'zod';
// SSRF 対策ガード (プライベート IP / ループバック / IPv6-mapped などを拒否する)
import { isUnsafeUrl } from '@/lib/ssrf-guard';

// Slack/Teams Incoming Webhook URL のバリデーションスキーマ。
// 空文字列は「通知を無効化する」意図として null に変換する (UI で「削除」ボタン相当の操作)。
// https:// で始まる URL のみ許容する (http:// は Webhook エンドポイントとして非推奨)。
const slackWebhookSchema = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : v)) // 空文字列 → null に変換 (通知無効化)
  .pipe(
    z
      .string()
      .url('有効な URL を入力してください')
      .startsWith('https://', 'Webhook URL は https:// で始まる必要があります')
      .nullable(),
  );

// Slack / Teams の Webhook URL を更新するサーバーアクション。
// 管理者 (admin) のみ実行可能。空文字列を渡すと通知が無効化される。
export async function updateSlackWebhookUrl(
  _prevState: { error?: string; success?: boolean },
  formData: FormData,
): Promise<{ error?: string; success?: boolean }> {
  // セッション取得と認証チェック
  const session = await auth();
  // 未ログインまたは tenantId 不在は拒否
  if (!session?.user?.id || !session.user.tenantId) {
    return { error: '認証が必要です' };
  }
  // 管理者以外は設定変更不可 (UI で非表示でも、直接 Action 呼び出しを防ぐため Server Action 側でも検証)
  if (session.user.role !== 'admin') {
    return { error: 'この操作は管理者のみ実行できます' };
  }

  // フォームデータから URL を取り出す (未入力時は空文字列)
  const rawUrl = String(formData.get('slackWebhookUrl') ?? '');

  // Zod でバリデーション + 空文字列 → null 変換
  const parsed = slackWebhookSchema.safeParse(rawUrl);
  if (!parsed.success) {
    // バリデーション失敗: 最初のエラーメッセージを返す
    return { error: parsed.error.issues[0]?.message ?? '入力値が正しくありません' };
  }

  // SSRF 対策: null (通知無効化) でなければ URL の安全性を検証する。
  // isUnsafeUrl は https:// 以外のスキームと、プライベート IP / ループバック /
  // IPv6-mapped アドレス / CGNAT / リンクローカルをリテラル判定でブロックする。
  // ※ DNS リバインディングはリテラルチェックでは防げないため、
  //   送信時 (sendOutboundNotification) でも再検証を行う (二重防御)。
  if (parsed.data !== null && isUnsafeUrl(parsed.data)) {
    return { error: '内部ネットワークへの Webhook URL は設定できません' };
  }

  // テナントの slackWebhookUrl を更新する (セッション由来の tenantId のみ使用してクロステナント変更を防止)
  await repos.tenants.updateSlackWebhookUrl(session.user.tenantId, parsed.data);

  // 設定ページを再レンダリングして最新値を反映する
  revalidatePath('/settings');

  // 成功を返す (UI でサクセストーストを出す)
  return { success: true };
}
