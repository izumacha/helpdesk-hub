'use server';

// Phase 4: 外部通知チャネル (Slack / Teams / Chatwork) の設定を更新する Server Action。
// 管理者 (admin) のみ実行可能。各フィールドを空欄で保存すると該当チャネルが無効化される。
// docs/smb-dx-pivot-plan.md §4 Phase 4「Slack / Chatwork / Microsoft Teams 通知 Adapter」。

// Next.js のキャッシュ無効化 (設定ページの再レンダリングに使う)
import { revalidatePath } from 'next/cache';
// 現在のセッション取得
import { auth } from '@/lib/auth';
// テナントリポジトリ
import { repos } from '@/data';
// SSRF 対策ガード (プライベート IP / ループバック / IPv6-mapped などを拒否する)
import { isUnsafeUrl } from '@/lib/ssrf-guard';
// 連打防止のための共通レート制限ヘルパー
import { checkRateLimit } from '@/lib/rate-limit';

// Chatwork API トークンの最大長 (常識的な上限。これを超える入力は不正として弾く)
const CHATWORK_TOKEN_MAX_LENGTH = 200;
// Chatwork ルーム ID が数字のみで構成されるかを検証する正規表現 (パスインジェクション防止)
const CHATWORK_ROOM_ID_PATTERN = /^\d+$/;

// Incoming Webhook URL (Slack / Teams 共通) を検証して保存値に変換するヘルパー。
// - 空文字列は null (= 通知無効) に変換する
// - https:// 以外や SSRF 危険な URL はエラーメッセージを返す
// 戻り値: { value } 成功時の保存値 (string | null) / { error } 検証失敗時のメッセージ
function validateWebhookUrl(
  raw: string,
  channelLabel: string,
): { value: string | null } | { error: string } {
  // 前後空白を除去する
  const trimmed = raw.trim();
  // 空欄なら通知無効として null を返す
  if (trimmed === '') return { value: null };
  // https:// で始まらない URL は拒否する (http:// は Webhook エンドポイントとして非推奨)
  if (!trimmed.startsWith('https://')) {
    return { error: `${channelLabel} の Webhook URL は https:// で始まる必要があります` };
  }
  // SSRF 対策: プライベート IP / ループバック / メタデータ等への URL を拒否する
  if (isUnsafeUrl(trimmed)) {
    return { error: `${channelLabel} に内部ネットワークの Webhook URL は設定できません` };
  }
  // 検証済みの URL を保存値として返す
  return { value: trimmed };
}

// 外部通知チャネルの設定を更新するサーバーアクション。
// useActionState 互換のシグネチャ (prevState, formData) を取る。
export async function updateNotificationChannels(
  _prevState: { error?: string; success?: boolean },
  formData: FormData,
): Promise<{ error?: string; success?: boolean }> {
  // セッション取得と認証チェック
  const session = await auth();
  // 未ログインまたは tenantId 不在は拒否
  if (!session?.user?.id || !session.user.tenantId) {
    return { error: '認証が必要です' };
  }
  // 管理者以外は設定変更不可 (UI 非表示でも直接 Action 呼び出しを防ぐため Server Action 側でも検証)
  if (session.user.role !== 'admin') {
    return { error: 'この操作は管理者のみ実行できます' };
  }
  // 検証済みの tenantId (セッション由来)
  const tenantId = session.user.tenantId;

  // 通知チャネル設定変更の連打を抑制 (60 秒あたり 10 回まで、テナント単位。
  // create/update/delete-location.ts と同じ上限・キー粒度の方針)
  const rateLimitError = checkRateLimit(`notification-channels-mutate:${tenantId}`, {
    limit: 10,
    windowMs: 60_000,
  });
  if (rateLimitError) return { error: rateLimitError };

  // ── Slack / Teams Webhook URL の検証 ────────────────────────────────────────
  // フォームから各チャネルの入力値を取り出す (未入力は空文字列)
  const slackResult = validateWebhookUrl(String(formData.get('slackWebhookUrl') ?? ''), 'Slack');
  // 検証失敗なら最初のエラーを返す
  if ('error' in slackResult) return { error: slackResult.error };
  const teamsResult = validateWebhookUrl(String(formData.get('teamsWebhookUrl') ?? ''), 'Teams');
  if ('error' in teamsResult) return { error: teamsResult.error };

  // ── Chatwork (API トークン + ルーム ID) の検証 ───────────────────────────────
  // トークンとルーム ID を取り出して前後空白を除去する
  const chatworkApiTokenRaw = String(formData.get('chatworkApiToken') ?? '').trim();
  const chatworkRoomIdRaw = String(formData.get('chatworkRoomId') ?? '').trim();
  // 両方空欄なら Chatwork 通知無効 (両方 null)。片方だけ入力はエラーにする
  const hasToken = chatworkApiTokenRaw !== '';
  const hasRoomId = chatworkRoomIdRaw !== '';
  if (hasToken !== hasRoomId) {
    // トークンとルーム ID は対で必要 (片方だけでは送信できない)
    return { error: 'Chatwork は API トークンとルーム ID の両方を入力してください' };
  }
  // トークンが長すぎる入力は不正として弾く (ヘッダに載るため常識的な上限を設ける)
  if (hasToken && chatworkApiTokenRaw.length > CHATWORK_TOKEN_MAX_LENGTH) {
    return { error: 'Chatwork API トークンの形式が正しくありません' };
  }
  // ルーム ID は数字のみ許可する (URL パスに埋め込むためインジェクションを防ぐ)
  if (hasRoomId && !CHATWORK_ROOM_ID_PATTERN.test(chatworkRoomIdRaw)) {
    return { error: 'Chatwork ルーム ID は数字で入力してください' };
  }
  // 保存値を決定する (未入力なら null = 無効化)
  const chatworkApiToken = hasToken ? chatworkApiTokenRaw : null;
  const chatworkRoomId = hasRoomId ? chatworkRoomIdRaw : null;

  // テナントの通知チャネル設定を一括更新する (セッション由来の tenantId のみ使用してクロステナント防止)
  await repos.tenants.updateNotificationChannels(tenantId, {
    slackWebhookUrl: slackResult.value,
    teamsWebhookUrl: teamsResult.value,
    chatworkApiToken,
    chatworkRoomId,
  });

  // 設定ページを再レンダリングして最新値を反映する (監査ログの成否に関わらず必ず実行する)
  revalidatePath('/settings');

  // §4.2 フォローアップ: 監査ログに「誰が通知チャネル設定を更新したか」を記録する
  // (chatworkApiToken 等の秘匿情報は記録しない。アクション名のみ)。
  // try/catch で囲む理由: 設定は既に保存済みなので、監査ログの書き込みだけが失敗しても
  // 管理者に「保存に失敗した」という誤ったエラーを見せてはいけない
  // (update-ticket.ts の外部通知失敗時と同じ方針)
  try {
    await repos.settingsAudit.record({
      tenantId,
      actorId: session.user.id,
      action: 'notification_channels_update',
    });
  } catch (auditErr) {
    console.error('[update-notification-channels] 監査ログの記録に失敗しました:', auditErr);
  }

  // 成功を返す (UI でサクセストーストを出す)
  return { success: true };
}
