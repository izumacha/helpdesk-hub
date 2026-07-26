// 認証イベント監査ログ (AuthAuditLog) リポジトリの契約 (port)。
// 課題棚卸し (2026-07-26) の否認防止ギャップ対応: ログイン成功/失敗・SSO アサーション受理が
// どこにも記録されておらず、インシデント調査時に「誰がいつどの方法で認証したか」を追えなかった。
//
// SettingsAuditLog (設定変更監査) と別テーブル・別 port にする理由:
//   - 失敗イベントは存在しないメールアドレスに対しても記録するため tenantId を必須にできない
//   - ログインは設定変更よりはるかに高頻度で、設定監査の一覧 UI に混ぜると視認性を損なう
//
// 記録専用 (書き込みのみ) の port。閲覧 UI は現時点では持たず、調査時は DB を直接参照する
// (必要になった時点で findAllByTenant 相当を追加する)。

// イベント種別の型
import type { AuthAuditEvent } from '@/domain/types';

// 認証イベントを 1 件記録する際に渡す入力値
export interface RecordAuthAuditInput {
  event: AuthAuditEvent; // 記録する認証イベントの種別
  email: string; // 試行対象のメールアドレス (呼び出し側で小文字正規化済みの値を渡す)
  userId: string | null; // 対応するユーザー ID (ユーザー不在の失敗時は null)
  tenantId: string | null; // 所属テナント ID (ユーザー不在の失敗時は null)
}

// 認証イベント監査ログ書き込み用リポジトリの契約 (port)
export interface AuthAuditLogRepository {
  record(input: RecordAuthAuditInput): Promise<void>; // 認証イベントを 1 件追記する
}
