// ロール (権限) 型を正準のドメイン型 (@/domain/types) からインポート
import type { Role } from '@/domain/types';

// 渡されたロールが「担当者権限を持っている」と判定できるかを返す関数
// agent または admin ならエージェント扱い (admin 限定チェックではないことに注意)
export function isAgent(role: Role | string | null | undefined): boolean {
  // 'agent' か 'admin' のいずれかに一致すれば true を返す
  return role === 'agent' || role === 'admin';
}
