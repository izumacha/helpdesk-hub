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
      tenantId: string; // 所属テナント ID (マルチテナント化のキー)
    } & DefaultSession['user']; // 既定の user フィールド (name/email/image) も維持
  }

  // authorize の戻り値型を拡張 (role と tenantId を必須化)
  interface User {
    role: Role; // 権限区分
    tenantId: string; // 所属テナント ID
  }
}

// JWT の中身も型拡張: jwt callback で token.tenantId を扱うため
declare module 'next-auth/jwt' {
  interface JWT {
    id?: string; // ユーザー ID
    role?: Role; // 権限
    tenantId?: string; // 所属テナント ID (旧 JWT には無いので optional)
  }
}
