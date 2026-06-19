// ロール (権限) 型を正準のドメイン型 (@/domain/types) からインポート
import type { Role } from '@/domain/types';
// セッション型 (型のみ。middleware の Edge バンドルには実体を持ち込まない)
import type { Session } from 'next-auth';

// 渡されたロールが「担当者権限を持っている」と判定できるかを返す関数
// agent または admin ならエージェント扱い (admin 限定チェックではないことに注意)
export function isAgent(role: Role | string | null | undefined): boolean {
  // 'agent' か 'admin' のいずれかに一致すれば true を返す
  return role === 'agent' || role === 'admin';
}

// セッションが管理者 (admin) 権限かつ tenantId を持つことを保証するアサーション関数。
// 組織設定 (モード切替・招待発行・テナント作成) は管理者専用のため、各 Server Action の
// 冒頭で呼んで RBAC をサーバー側で強制する (UI 非表示には頼らない)。
// 通過後は session が非 null に narrow され、session.user.tenantId / role を安全に使える。
export function assertAdminSession(session: Session | null): asserts session is Session {
  // 未ログイン (ユーザー ID 無し) は拒否
  if (!session?.user?.id) throw new Error('ログインが必要です');
  // tenantId 不在は middleware で弾く想定だが、Server Action でも防御的にチェック
  if (!session.user.tenantId) throw new Error('ログインが必要です');
  // admin 以外 (agent / requester) は拒否 (組織設定は管理者専用)
  if (session.user.role !== 'admin') {
    throw new Error('この操作は管理者のみ実行できます');
  }
}
