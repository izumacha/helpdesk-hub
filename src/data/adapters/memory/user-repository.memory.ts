// ユーザーリポジトリの契約 (port)・一覧系メソッド共通の上限と、ドメイン型/ストア型をインポート
import { USER_LIST_LIMIT, type UserRepository } from '@/data/ports/user-repository';
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
      // 監査で発見したギャップ対応: USER_LIST_LIMIT で上限を設ける (Prisma アダプタの take と同じ)
      return agents.slice(0, USER_LIST_LIMIT);
    },

    // 当該テナント内の全ユーザー (ロール問わず) を名前順で一覧取得 (フォローアップ 2026-07-14:
    // CSV インポートの「起票者」列名解決用。起票者は依頼者もなり得るため listAgents では絞り込めない)
    async listByTenant(tenantId) {
      // 結果を入れる配列を準備
      const out: UserSummary[] = [];
      // 全ユーザーを走査し、テナント一致だけ抽出 (ロールは問わない)
      for (const u of store.users.values()) {
        if (u.tenantId !== tenantId) continue; // 他テナントは除外
        out.push({ id: u.id, name: u.name });
      }
      // 名前でロケール順に並び替え
      out.sort((a, b) => a.name.localeCompare(b.name));
      // 監査で発見したギャップ対応: USER_LIST_LIMIT で上限を設ける
      return out.slice(0, USER_LIST_LIMIT);
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
      // 監査で発見したギャップ対応: USER_LIST_LIMIT で上限を設ける
      return ids.slice(0, USER_LIST_LIMIT);
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

    // 当該テナント内の agent / admin の id + email を一覧取得 (一斉メール送信用)
    async listAgentEmails(tenantId) {
      // 結果配列
      const out: Array<{ id: string; email: string }> = [];
      // 全ユーザーを走査し、テナント一致かつ対象ロールだけ抽出
      for (const u of store.users.values()) {
        if (u.tenantId !== tenantId) continue; // 他テナントは除外
        if (u.role === 'agent' || u.role === 'admin') out.push({ id: u.id, email: u.email });
      }
      // 監査で発見したギャップ対応: USER_LIST_LIMIT で上限を設ける
      return out.slice(0, USER_LIST_LIMIT);
    },

    // §7.2 Free trial 終了リマインダー等、課金関連の通知先として admin のみの id + email を取得
    async listAdminEmails(tenantId) {
      // 結果配列
      const out: Array<{ id: string; email: string }> = [];
      // 全ユーザーを走査し、テナント一致かつ admin ロールだけ抽出 (agent は含まない)
      for (const u of store.users.values()) {
        if (u.tenantId !== tenantId) continue; // 他テナントは除外
        if (u.role === 'admin') out.push({ id: u.id, email: u.email });
      }
      // 監査で発見したギャップ対応: USER_LIST_LIMIT で上限を設ける
      return out.slice(0, USER_LIST_LIMIT);
    },

    // Phase 4 課金: テナント内のスタッフ (agent + admin) 数を返す (プランのシート上限チェック用)
    // requester (エンドユーザー) はシートを消費しない — ヘルプデスク製品の標準的な課金モデル
    async countByTenant(tenantId) {
      // agent と admin のみをカウントする (requester は上限対象外)
      let count = 0;
      for (const u of store.users.values()) {
        // テナントが一致し、かつスタッフロール (agent | admin) のユーザーのみ数える
        if (u.tenantId === tenantId && (u.role === 'agent' || u.role === 'admin')) count++;
      }
      return count;
    },

    // 紐付け済み LINE ユーザー ID から当該テナントのメンバーを 1 件引く (tenantId スコープ)
    async findByLineUserId(tenantId, lineUserId) {
      // 全ユーザーを走査し、テナント一致かつ lineUserId 一致を返す (複製して返却)
      for (const u of store.users.values()) {
        if (u.tenantId === tenantId && u.lineUserId === lineUserId) return { ...u };
      }
      return null;
    },

    // メンバー起点でワンタイムコードのハッシュと失効時刻を自分のユーザー行に保存する
    async setLineLinkCode(userId, tenantId, input) {
      const u = store.users.get(userId);
      // 自テナントの自分だけを更新対象にする (他テナント・不在はスキップ)
      if (!u || u.tenantId !== tenantId) return;
      // コードのハッシュと失効時刻を書き込む (Map 内のオブジェクトを直接更新)
      u.lineLinkCodeHash = input.codeHash;
      u.lineLinkCodeExpiresAt = input.expiresAt;
    },

    // 受信コードのハッシュに一致する有効な発行行を探し、lineUserId を紐付ける
    async linkLineUserByCode({ codeHash, tenantId, lineUserId, now }) {
      // 1) 有効な発行行 (同一テナント・未失効) を探す
      let candidate: User | undefined;
      for (const u of store.users.values()) {
        if (
          u.tenantId === tenantId &&
          u.lineLinkCodeHash === codeHash &&
          u.lineLinkCodeExpiresAt != null &&
          u.lineLinkCodeExpiresAt.getTime() >= now.getTime()
        ) {
          candidate = u;
          break;
        }
      }
      // 一致する有効コードが無ければ「コードではない」
      if (!candidate) return { status: 'invalid' };

      // 2) その LINE ユーザー ID が既に別メンバーへ連携済みなら付け替えない (テナント内一意)
      for (const u of store.users.values()) {
        if (u.tenantId === tenantId && u.lineUserId === lineUserId && u.id !== candidate.id) {
          return { status: 'conflict' };
        }
      }

      // 3) コード消費 + lineUserId 設定 (Map 内オブジェクトを直接更新)
      candidate.lineUserId = lineUserId;
      candidate.lineLinkCodeHash = null;
      candidate.lineLinkCodeExpiresAt = null;
      return { status: 'linked', userId: candidate.id };
    },

    // メンバー起点で LINE 連携を解除する (lineUserId と発行中コードをまとめてクリア)
    async unlinkLineUser(userId, tenantId) {
      const u = store.users.get(userId);
      // 自テナントの自分だけを対象にする
      if (!u || u.tenantId !== tenantId) return;
      u.lineUserId = null;
      u.lineLinkCodeHash = null;
      u.lineLinkCodeExpiresAt = null;
    },
  };
}
