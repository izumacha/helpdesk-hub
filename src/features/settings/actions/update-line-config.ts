'use server';

// Phase 2 フォローアップ: テナント単位の LINE 公式アカウント連携設定を作成/更新する Server Action。
// Pro / Enterprise プランの管理者のみ実行可能。docs/smb-dx-pivot-plan.md §4 Phase 2.1。

// Next.js のキャッシュ無効化 (設定ページの再レンダリングに使う)
import { revalidatePath } from 'next/cache';
// データリポジトリ (LINE 連携設定 upsert)
import { repos } from '@/data';
// LINE 連携設定変更の共有認可ゲート (ログイン済み・admin・Pro/Enterprise)
import { assertLineConfigAdmin } from '@/lib/line-config-context';
// LINE ユーザー ID / Bot User ID の正規形式 (Webhook 受信側と共有する単一の源)
import { LINE_USER_ID_PATTERN } from '@/lib/line-link';
// 連打防止のための共通レート制限ヘルパー
import { checkRateLimit } from '@/lib/rate-limit';
// 設定変更監査ログへの記録を共通化するヘルパー
import { recordSettingsAudit } from '@/lib/settings-audit';

// 入力長の上限 (DoS・異常入力対策)
const CHANNEL_SECRET_MAX = 256; // チャネルシークレットの最大長
const CHANNEL_ACCESS_TOKEN_MAX = 1024; // アクセストークンの最大長 (LINE の長期トークンは十分収まる)

// LINE 連携設定の更新結果型 (useActionState 互換)
export interface UpdateLineConfigState {
  error?: string; // エラーメッセージ
  success?: boolean; // 成功フラグ
}

// LINE 連携設定を作成/更新するサーバーアクション (useActionState 互換シグネチャ)
export async function updateLineConfig(
  _prevState: UpdateLineConfigState,
  formData: FormData,
): Promise<UpdateLineConfigState> {
  // 共有ゲートで「ログイン済み・admin・Pro/Enterprise」をまとめて検証する
  const gate = await assertLineConfigAdmin();
  // ゲート不通過ならその理由をそのまま返す
  if (!gate.ok) return { error: gate.error };
  // 検証済みの tenantId (セッション由来)
  const tenantId = gate.tenantId;

  // LINE 連携設定の作成・更新・削除の連打を抑制 (60 秒あたり 10 回まで、テナント単位で
  // create/update/delete-location.ts と共有する)。update/delete で同じキーを共有する
  // 理由も同じ (アクション別に分けると実質の上限が action 数倍になってしまう)
  const rateLimitError = checkRateLimit(`line-config-mutate:${tenantId}`, {
    limit: 10,
    windowMs: 60_000,
  });
  if (rateLimitError) return { error: rateLimitError };

  // フォームから各値を取り出して前後空白を除去する。
  // channelSecret / channelAccessToken は書き込み専用フィールド (§9 秘密情報をフロントに
  // 露出させない): 設定画面はこれらの現在値を表示しない。空欄で送信された場合は
  // 「変更しない」ことを意味し、既存の値をそのまま維持する (新規設定時は必須)。
  const channelSecretInput = String(formData.get('channelSecret') ?? '').trim();
  const channelAccessTokenInput = String(formData.get('channelAccessToken') ?? '').trim();
  const botUserId = String(formData.get('botUserId') ?? '').trim();

  // 既存設定を取得する (空欄フィールドを既存値で補うため、および必須判定のため)
  const existing = await repos.lineConfigs.findByTenant(tenantId);

  // 空欄なら既存値を維持し、入力があればそれを採用する
  const channelSecret = channelSecretInput || existing?.channelSecret || '';
  const channelAccessToken = channelAccessTokenInput || existing?.channelAccessToken || '';

  // チャネルシークレットの検証 (新規設定時は必須・長さ上限)
  if (!channelSecret) return { error: 'チャネルシークレットは必須です' };
  if (channelSecret.length > CHANNEL_SECRET_MAX) {
    return { error: 'チャネルシークレットが長すぎます' };
  }

  // アクセストークンの検証 (新規設定時は必須・長さ上限)
  if (!channelAccessToken) return { error: 'チャネルアクセストークンは必須です' };
  if (channelAccessToken.length > CHANNEL_ACCESS_TOKEN_MAX) {
    return { error: 'チャネルアクセストークンが長すぎます' };
  }

  // Bot User ID の検証 (必須・LINE ユーザー ID と同じ 'U' + 32 桁 16 進数の形式)。
  // Webhook 受信 (/api/inbound/line) はこの値と destination の一致でテナントを解決するため、
  // 形式外の値を登録させると絶対に一致せず連携が機能しなくなる (事前に弾いて設定ミスを防ぐ)。
  // Bot User ID 自体は秘密情報ではないため、既存値の表示・再送信は問題ない。
  if (!botUserId) return { error: 'Bot User ID は必須です' };
  if (!LINE_USER_ID_PATTERN.test(botUserId)) {
    return { error: 'Bot User ID の形式が正しくありません ("U" + 32桁の16進数)' };
  }

  try {
    // LINE 連携設定を upsert する (tenantId スコープで他テナントに影響しない)
    await repos.lineConfigs.upsert({
      tenantId,
      channelSecret,
      channelAccessToken,
      botUserId,
    });
    // 設定ページのキャッシュを無効化して結果をすぐ反映する
    revalidatePath('/settings');

    // §4.2 フォローアップ: 監査ログに「誰が LINE 連携設定を更新したか」を記録する
    // (channelSecret 等の秘匿情報は記録しない。アクション名のみ)
    await recordSettingsAudit({
      tenantId,
      actorId: gate.userId,
      action: 'line_config_update',
      logPrefix: '[update-line-config]',
    });

    // 成功を返す
    return { success: true };
  } catch (err) {
    // botUserId の重複 (他テナントが既に同じチャネルを登録済み) をユーザー向けメッセージに変換する
    const message = err instanceof Error ? err.message : '';
    if (message.includes('Unique constraint') || message.includes('P2002')) {
      return { error: 'この Bot User ID は既に別のテナントで登録されています' };
    }
    // その他の失敗はログに残して汎用メッセージを返す (内部詳細を漏らさない)
    console.error('[update-line-config] LINE 連携設定の保存に失敗しました:', err);
    return { error: 'LINE 連携設定の保存に失敗しました' };
  }
}
