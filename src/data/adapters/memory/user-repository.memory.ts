// ユーザーリポジトリの契約 (port) と、ドメイン型/ストア型をインポート
import type { UserRepository } from '@/data/ports/user-repository';
import type { User, UserSummary } from '@/domain/types';
import { nextId, type Store } from './store';

// メモリストアを使ったユーザーリポジトリを生成する関数
export function makeUserRepo(store: Store): UserRepository {
  return {
    // ID で 1 件取得 (認証フロー用。tenantId スコープなし)
    async findById(id) {
      const u = store.users.get(id); // Map から取得
      return u ? { ...u } : null; // 破壊防止のためスプレッドで複製して返す
    },

    // メールアドレスで 1 件取得 (ログイン用。テナント横断検索)
    async findByEmail(email) {
      // 全ユーザーを走査
      for (const u of store.users.values()) {
        // メール一致で即返す (複製して返却)
        if (u.email === email) return { ...u };
      }
      // 見つからなければ null
      return null;
    },

    // 新規ユーザーを 1 件作成する (招待受諾・初代管理者登録用)
    async create(input) {
      // email の @unique 制約を擬似的に再現する: 既存メールと重複したら例外で弾く
      for (const u of store.users.values()) {
        if (u.email === input.email) {
          // Prisma の P2002 (unique 制約違反) 相当のエラーを投げて呼び出し側に重複を伝える
          throw new Error('このメールアドレスは既に登録されています');
        }
      }
      // 現在時刻 (作成・更新日時に使う)
      const now = new Date();
      // 新しいユーザー行を組み立てる
      const user: User = {
        id: nextId(store, 'usr'), // 'usr_...' 形式の一意 ID
        email: input.email,
        name: input.name,
        passwordHash: input.passwordHash,
        role: input.role,
        tenantId: input.tenantId,
        createdAt: now,
        updatedAt: now,
      };
      // ストアの Map に登録
      store.users.set(user.id, user);
      // 防御的コピーを返す
      return { ...user };
    },

    // 当該テナント内の agent または admin を名前順で一覧取得
    async listAgents(tenantId) {
      // 結果を入れる配列を準備
      const agents: UserSummary[] = [];
      // 全ユーザーを走査し、テナント一致かつエージェント系だけ抽出
      for (const u of store.users.values()) {
        if (u.tenantId !== tenantId) continue; // 他テナントは除外
        if (u.role === 'agent' || u.role === 'admin') {
          agents.push({ id: u.id, name: u.name });
        }
      }
      // 名前でロケール順に並び替え
      agents.sort((a, b) => a.name.localeCompare(b.name));
      // 結果を返す
      return agents;
    },

    // 当該テナント内の agent または admin の ID だけを一覧取得
    async listAgentIds(tenantId) {
      // 結果 ID 配列
      const ids: string[] = [];
      // 全ユーザーを走査し、テナント一致かつ対象ロールの ID を追加
      for (const u of store.users.values()) {
        if (u.tenantId !== tenantId) continue; // 他テナントは除外
        if (u.role === 'agent' || u.role === 'admin') ids.push(u.id);
      }
      // 結果を返す
      return ids;
    },

    // 指定 ID 群に含まれる当該テナント内ユーザーの概要をまとめて返す
    async findSummariesByIds(ids, tenantId) {
      // 検索効率化のため ID を Set にする
      const set = new Set(ids);
      // 結果配列
      const out: UserSummary[] = [];
      // 全ユーザーを走査し、テナント一致かつ ID 一致だけ抽出
      for (const u of store.users.values()) {
        if (u.tenantId !== tenantId) continue; // 他テナントは除外
        if (set.has(u.id)) out.push({ id: u.id, name: u.name });
      }
      // 結果を返す
      return out;
    },
  };
}
