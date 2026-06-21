'use server';

// Next.js のキャッシュ無効化 (設定ページの再レンダリングに使う)
import { revalidatePath } from 'next/cache';
// 現在のセッション取得
import { auth } from '@/lib/auth';
// テナントリポジトリ
import { repos } from '@/data';
// URL バリデーション用 Zod スキーマ
import { z } from 'zod';

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

// プライベート IP / ループバック / リンクローカルのホスト名を検出する関数。
// SSRF (Server-Side Request Forgery) 対策として、内部ネットワークやクラウドメタデータ
// エンドポイント (169.254.169.254 など) への Webhook URL 設定を防ぐ (§9 SSRF 対策)。
// DNS ルックアップなしでリテラル IP パターンのみ判定する (DNS リバインディングは別レイヤ対策)。
function isPrivateHost(hostname: string): boolean {
  // 小文字に正規化する (IPv6 アドレスの大文字表記に対応)
  const h = hostname.toLowerCase();
  // ループバック (127.0.0.0/8 と ::1)
  if (h === 'localhost' || /^127\./.test(h) || h === '[::1]' || h === '::1') return true;
  // リンクローカル (IMDS 169.254.169.254 を含む 169.254.0.0/16)
  if (/^169\.254\./.test(h)) return true;
  // プライベート: 10.0.0.0/8
  if (/^10\./.test(h)) return true;
  // プライベート: 172.16.0.0/12 (172.16.x.x ～ 172.31.x.x)
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  // プライベート: 192.168.0.0/16
  if (/^192\.168\./.test(h)) return true;
  // ANY-ADDRESS
  if (h === '0.0.0.0') return true;
  // 上記に該当しない場合はパブリックホストとみなす
  return false;
}

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

  // SSRF 対策: null (通知無効化) でなければホスト名を検証する
  // プライベート IP やループバックへの Webhook 設定はサーバー側フェッチで内部リソースを叩く可能性があるため拒否する
  if (parsed.data !== null) {
    let urlHostname: string;
    try {
      // URL をパースしてホスト名を取り出す (URL が不正な場合は catch で弾く)
      urlHostname = new URL(parsed.data).hostname;
    } catch {
      // URL パース失敗 (Zod の url() を通過した後のパースなので通常ここは到達しないが防御的に処理)
      return { error: '有効な URL を入力してください' };
    }
    // プライベートホストへのリクエストを拒否する
    if (isPrivateHost(urlHostname)) {
      return { error: '内部ネットワークへの Webhook URL は設定できません' };
    }
  }

  // テナントの slackWebhookUrl を更新する (セッション由来の tenantId のみ使用してクロステナント変更を防止)
  await repos.tenants.updateSlackWebhookUrl(session.user.tenantId, parsed.data);

  // 設定ページを再レンダリングして最新値を反映する
  revalidatePath('/settings');

  // 成功を返す (UI でサクセストーストを出す)
  return { success: true };
}
