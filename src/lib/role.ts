// Prisma が生成したロール (権限) 型をインポート
import type { Role } from '@/generated/prisma';

// 渡されたロールが「担当者権限を持っている」と判定できるかを返す関数
// agent または admin ならエージェント扱い (admin 限定チェックではないことに注意)
export function isAgent(role: Role | string | null | undefined): boolean {
  // 'agent' か 'admin' のいずれかに一致すれば true を返す
  return role === 'agent' || role === 'admin';
}
