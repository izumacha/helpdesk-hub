// ユーザーリポジトリの契約 (port) と、ドメイン型/ストア型をインポート
import type { UserRepository } from '@/data/ports/user-repository';
import type { UserSummary } from '@/domain/types';
import type { Store } from './store';

// メモリストアを使ったユーザーリポジトリを生成する関数
export function makeUserRepo(store: Store): UserRepository {
  return {
    // ID で 1 件取得 (見つからなければ null)
    async findById(id) {
      const u = store.users.get(id); // Map から取得
      return u ? { ...u } : null; // 破壊防止のためスプレッドで複製して返す
    },

    // メールアドレスで 1 件取得 (線形検索)
    async findByEmail(email) {
      // 全ユーザーを走査
      for (const u of store.users.values()) {
        // メール一致で即返す (複製して返却)
        if (u.email === email) return { ...u };
      }
      // 見つからなければ null
      return null;
    },

    // agent または admin を名前順で一覧取得
    async listAgents() {
      // 結果を入れる配列を準備
      const agents: UserSummary[] = [];
      // 全ユーザーを走査し、エージェント系だけ抽出
      for (const u of store.users.values()) {
        if (u.role === 'agent' || u.role === 'admin') {
          agents.push({ id: u.id, name: u.name });
        }
      }
      // 名前でロケール順に並び替え
      agents.sort((a, b) => a.name.localeCompare(b.name));
      // 結果を返す
      return agents;
    },

    // agent または admin の ID だけを一覧取得 (通知一斉送信などに使用)
    async listAgentIds() {
      // 結果 ID 配列
      const ids: string[] = [];
      // 全ユーザーを走査し、対象の ID を追加
      for (const u of store.users.values()) {
        if (u.role === 'agent' || u.role === 'admin') ids.push(u.id);
      }
      // 結果を返す
      return ids;
    },

    // 指定 ID 群に含まれるユーザーの概要をまとめて返す
    async findSummariesByIds(ids) {
      // 検索効率化のため ID を Set にする
      const set = new Set(ids);
      // 結果配列
      const out: UserSummary[] = [];
      // 全ユーザーを走査し、Set に含まれる ID だけ抽出
      for (const u of store.users.values()) {
        if (set.has(u.id)) out.push({ id: u.id, name: u.name });
      }
      // 結果を返す
      return out;
    },
  };
}
