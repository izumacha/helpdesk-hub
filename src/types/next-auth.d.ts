// next-auth (認証ライブラリ) の既定セッション型をインポート
import type { DefaultSession } from 'next-auth';
// Prisma が生成したロール (権限) 型をインポート
import type { Role } from '@/generated/prisma';

// next-auth モジュールの型定義を拡張するブロック (モジュール拡張)
declare module 'next-auth' {
  // Session 型を拡張し、独自フィールドを追加する
  interface Session {
    user: {
      id: string; // ユーザー ID を session.user.id で参照できるようにする
      role: Role; // 権限 (requester/agent/admin) を session.user.role で参照できるようにする
    } & DefaultSession['user']; // 既定の user フィールド (name/email/image) も維持
  }
}
