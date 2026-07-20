'use server';

// Phase 4: 外部通知チャネル (Slack / Teams / Chatwork) の設定を更新する Server Action。
// 管理者 (admin) のみ実行可能。各フィールドを空欄で保存すると該当チャネルが無効化される。
// docs/smb-dx-pivot-plan.md §4 Phase 4「Slack / Chatwork / Microsoft Teams 通知 Adapter」。

// Next.js のキャッシュ無効化 (設定ページの再レンダリングに使う)
import { revalidatePath } from 'next/cache';
// 「ログイン済み・admin・自テナント」を検証する共有ゲート (create-location.ts 等と同じ
// 非throw系アクションで共有する。§6 DRY: 個別に複製していた認証+ロールブロックを集約)
import { assertTenantAdmin } from '@/lib/tenant-admin-gate';
// テナントリポジトリ
import { repos } from '@/data';
// SSRF 対策ガード (プライベート IP / ループバック / IPv6-mapped などを拒否する)
import { isUnsafeUrl } from '@/lib/ssrf-guard';
// 連打防止のための共通レート制限ヘルパー
import { checkRateLimit } from '@/lib/rate-limit';
// 設定変更監査ログへの記録を共通化するヘルパー
import { recordSettingsAudit } from '@/lib/settings-audit';

// Chatwork API トークンの最大長 (常識的な上限。これを超える入力は不正として弾く)
const CHATWORK_TOKEN_MAX_LENGTH = 200;
// Chatwork ルーム ID の最大長 (常識的な上限。トークンと同じ方針で入力を弾く)
const CHATWORK_ROOM_ID_MAX_LENGTH = 200;
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
  // 共有ゲートで「ログイン済み・admin・自テナント」をまとめて検証する
  const gate = await assertTenantAdmin();
  // ゲート不通過ならその理由をそのまま返す
  if (!gate.ok) return { error: gate.error };
  // 検証済みの tenantId (セッション由来)
  const tenantId = gate.tenantId;

  // 監査で発見したギャップ対応: 更新前の設定値を取得しておく。どのチャネルが実際に
  // 変更されたか (=管理者が修正を試みたか) を後で判定するために使う。
  // フォローアップ (監査で発見したギャップ): この読み取りスナップショットを CAS の
  // expected としても使う (読み取りと書き込みの間に他の管理者が値を変えていないことを保証する)
  const beforeTenant = await repos.tenants.findById(tenantId);
  if (!beforeTenant) {
    return { error: 'テナント情報が見つかりません' };
  }

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
  // ルーム ID が長すぎる入力は不正として弾く (トークンと同じ常識的な上限を設ける)
  if (hasRoomId && chatworkRoomIdRaw.length > CHATWORK_ROOM_ID_MAX_LENGTH) {
    return { error: 'Chatwork ルーム ID は数字で入力してください' };
  }
  // ルーム ID は数字のみ許可する (URL パスに埋め込むためインジェクションを防ぐ)
  if (hasRoomId && !CHATWORK_ROOM_ID_PATTERN.test(chatworkRoomIdRaw)) {
    return { error: 'Chatwork ルーム ID は数字で入力してください' };
  }
  // 保存値を決定する (未入力なら null = 無効化)
  const chatworkApiToken = hasToken ? chatworkApiTokenRaw : null;
  const chatworkRoomId = hasRoomId ? chatworkRoomIdRaw : null;

  // テナントの通知チャネル設定を一括更新する (セッション由来の tenantId のみ使用してクロステナント防止)。
  // フォローアップ (監査で発見したギャップ): 読み取り時点のスナップショット (beforeTenant) を
  // expected として渡す CAS にする。他の管理者が読み取りと書き込みの間に値を変えていた場合は
  // 0 件更新 (false) になり、その変更を黙って上書きしない
  const updated = await repos.tenants.updateNotificationChannels(
    tenantId,
    {
      slackWebhookUrl: slackResult.value,
      teamsWebhookUrl: teamsResult.value,
      chatworkApiToken,
      chatworkRoomId,
    },
    {
      slackWebhookUrl: beforeTenant.slackWebhookUrl,
      teamsWebhookUrl: beforeTenant.teamsWebhookUrl,
      chatworkApiToken: beforeTenant.chatworkApiToken,
      chatworkRoomId: beforeTenant.chatworkRoomId,
    },
  );
  if (!updated) {
    // 競合時もフォームの表示を最新化できるよう再レンダリングしておく
    // (StatusSelect/FaqStatusButton の router.refresh() と同じ「エラー時に最新状態を取り直す」方針)
    revalidatePath('/settings');
    return { error: '他の管理者による変更と競合しました。最新の設定を確認してから再度お試しください。' };
  }

  // 設定ページを再レンダリングして最新値を反映する (監査ログの成否に関わらず必ず実行する)
  revalidatePath('/settings');

  // 監査で発見したギャップ対応: 設定値が実際に変わったチャネルだけ、直近の送信失敗記録を
  // クリアする (管理者が Webhook URL/トークンを直したのに「⚠️ 最終送信失敗」バッジが
  // 次の送信成功まで残り続けるのを防ぐ)。触っていないチャネルは本当に直したわけではないため
  // 失敗記録を残したままにする。記録クリア自体の失敗は保存結果に影響させない (ログのみ)
  try {
    if (slackResult.value !== beforeTenant.slackWebhookUrl) {
      // Slack の Webhook URL が変わったのでクリアする
      await repos.tenants.recordOutboundChannelResult(tenantId, 'slack', null);
    }
    if (teamsResult.value !== beforeTenant.teamsWebhookUrl) {
      // Teams の Webhook URL が変わったのでクリアする
      await repos.tenants.recordOutboundChannelResult(tenantId, 'teams', null);
    }
    if (
      chatworkApiToken !== beforeTenant.chatworkApiToken ||
      chatworkRoomId !== beforeTenant.chatworkRoomId
    ) {
      // Chatwork のトークン/ルーム ID のどちらかが変わったのでクリアする
      await repos.tenants.recordOutboundChannelResult(tenantId, 'chatwork', null);
    }
  } catch (err) {
    console.error('[update-notification-channels] 失敗記録のクリアに失敗しました:', err);
  }

  // §4.2 フォローアップ: 監査ログに「誰が通知チャネル設定を更新したか」を記録する
  // (chatworkApiToken 等の秘匿情報は記録しない。アクション名のみ)
  await recordSettingsAudit({
    tenantId,
    actorId: gate.userId,
    action: 'notification_channels_update',
    logPrefix: '[update-notification-channels]',
  });

  // 成功を返す (UI でサクセストーストを出す)
  return { success: true };
}
