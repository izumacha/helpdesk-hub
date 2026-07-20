// LINE 連携設定リポジトリの契約 (port)
import type { LineConfigRepository } from '@/data/ports/line-config-repository';
// テスト用メモリストア
import type { Store } from './store';

// メモリストアを使った LINE 連携設定リポジトリを生成するファクトリ関数 (テスト用)
export function makeLineConfigRepo(store: Store): LineConfigRepository {
  return {
    // テナントの LINE 連携設定を取得する (未設定なら null)
    async findByTenant(tenantId) {
      // ストアの値から tenantId が一致する設定を線形探索する
      for (const cfg of store.lineConfigs.values()) {
        // 一致したらその設定を返す (1 テナント 1 設定)
        if (cfg.tenantId === tenantId) return cfg;
      }
      // 見つからなければ null
      return null;
    },

    // destination (Bot User ID) からテナントの LINE 連携設定を取得する (未登録なら null)
    async findByBotUserId(botUserId) {
      // ストアの値から botUserId が一致する設定を線形探索する
      for (const cfg of store.lineConfigs.values()) {
        // 一致したらその設定を返す (botUserId は @unique)
        if (cfg.botUserId === botUserId) return cfg;
      }
      // 見つからなければ null
      return null;
    },

    // LINE 連携設定を作成または更新する (tenantId をキーに upsert)
    async upsert(input) {
      // botUserId の一意性を確認する (他テナントが既に同じチャネルを登録していないか)
      for (const cfg of store.lineConfigs.values()) {
        if (cfg.botUserId === input.botUserId && cfg.tenantId !== input.tenantId) {
          // Prisma の P2002 (unique 制約違反) 相当のエラーを投げて呼び出し側に重複を伝える
          throw new Error('Unique constraint failed on the fields: (`botUserId`) (P2002)');
        }
      }
      // 既存設定を探す
      let existing = null as null | string;
      for (const [id, cfg] of store.lineConfigs.entries()) {
        // tenantId が一致する設定の Map キー (id) を控える
        if (cfg.tenantId === input.tenantId) existing = id;
      }
      // 現在時刻 (作成/更新日時に使う)
      const now = new Date();
      if (existing) {
        // 既存設定を取り出して値を更新する
        const cfg = store.lineConfigs.get(existing)!;
        // CAS: expected が渡されていれば、現在値がそれと一致するときだけ更新する
        // (Prisma アダプタの updateMany 版 CAS と同じ契約。§9 fail-closed で後勝ち上書きを防ぐ)
        if (
          input.expected &&
          (cfg.channelSecret !== input.expected.channelSecret ||
            cfg.channelAccessToken !== input.expected.channelAccessToken ||
            cfg.botUserId !== input.expected.botUserId)
        ) {
          // 読み取り後に他の更新が割り込んでいた (競合) ため null を返し、上書きしない
          return null;
        }
        // 更新後の設定オブジェクトを組み立てる (createdAt は維持、updatedAt を更新)
        const updated = {
          ...cfg,
          channelSecret: input.channelSecret, // Webhook 署名検証用シークレット
          channelAccessToken: input.channelAccessToken, // Messaging API push 用アクセストークン
          botUserId: input.botUserId, // このチャネルの Bot User ID
          updatedAt: now, // 更新日時を現在時刻に差し替え
        };
        // ストアへ書き戻す
        store.lineConfigs.set(existing, updated);
        // 更新後の設定を返す
        return updated;
      }
      // 新規作成: 連番から ID を払い出す
      const id = `line_cfg_${++store.idSeq.value}`;
      // 新規設定オブジェクトを組み立てる
      const created = {
        id, // 払い出した ID
        tenantId: input.tenantId, // 所属テナント (セッション由来のみ)
        channelSecret: input.channelSecret, // Webhook 署名検証用シークレット
        channelAccessToken: input.channelAccessToken, // Messaging API push 用アクセストークン
        botUserId: input.botUserId, // このチャネルの Bot User ID
        createdAt: now, // 作成日時
        updatedAt: now, // 更新日時 (作成時は作成日時と同じ)
      };
      // ストアへ保存する
      store.lineConfigs.set(id, created);
      // 作成した設定を返す
      return created;
    },

    // テナントの LINE 連携設定を削除する (tenantId スコープ)
    async delete(tenantId) {
      // tenantId が一致する設定を探して削除する
      for (const [id, cfg] of store.lineConfigs.entries()) {
        // 一致したら Map から削除する
        if (cfg.tenantId === tenantId) store.lineConfigs.delete(id);
      }
    },
  };
}
