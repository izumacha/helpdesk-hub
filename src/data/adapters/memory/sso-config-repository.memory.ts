// SSO 設定リポジトリの契約 (port)
import type { SsoConfigRepository } from '@/data/ports/sso-config-repository';
// テスト用メモリストア
import type { Store } from './store';

// メモリストアを使った SSO 設定リポジトリを生成するファクトリ関数 (テスト用)
export function makeSsoConfigRepo(store: Store): SsoConfigRepository {
  return {
    // テナントの SSO 設定を取得する (未設定なら null)
    async findByTenant(tenantId) {
      // ストアの値から tenantId が一致する設定を線形探索する
      for (const cfg of store.ssoConfigs.values()) {
        // 一致したらその設定を返す (1 テナント 1 設定)
        if (cfg.tenantId === tenantId) return cfg;
      }
      // 見つからなければ null
      return null;
    },

    // SSO 設定を作成または更新する (tenantId をキーに upsert)
    async upsert(input) {
      // 既存設定を探す
      let existing = null as null | string;
      for (const [id, cfg] of store.ssoConfigs.entries()) {
        // tenantId が一致する設定の Map キー (id) を控える
        if (cfg.tenantId === input.tenantId) existing = id;
      }
      // 現在時刻 (作成/更新日時に使う)
      const now = new Date();
      if (existing) {
        // 既存設定を取り出して値を更新する
        const cfg = store.ssoConfigs.get(existing)!;
        // CAS: expected が渡されていれば、現在値がそれと一致するときだけ更新する
        // (Prisma アダプタの updateMany 版 CAS と同じ契約。§9 fail-closed で後勝ち上書きを防ぐ)
        if (
          input.expected &&
          (cfg.enabled !== input.expected.enabled ||
            cfg.idpEntityId !== input.expected.idpEntityId ||
            cfg.idpSsoUrl !== input.expected.idpSsoUrl ||
            cfg.idpX509Cert !== input.expected.idpX509Cert)
        ) {
          // 読み取り後に他の更新が割り込んでいた (競合) ため null を返し、上書きしない
          return null;
        }
        // 更新後の設定オブジェクトを組み立てる (createdAt は維持、updatedAt を更新)
        const updated = {
          ...cfg,
          enabled: input.enabled,
          idpEntityId: input.idpEntityId,
          idpSsoUrl: input.idpSsoUrl,
          idpX509Cert: input.idpX509Cert,
          updatedAt: now,
        };
        // ストアへ書き戻す
        store.ssoConfigs.set(existing, updated);
        // 更新後の設定を返す
        return updated;
      }
      // 新規作成: 連番から ID を払い出す
      const id = `sso_${++store.idSeq.value}`;
      // 新規設定オブジェクトを組み立てる
      const created = {
        id,
        tenantId: input.tenantId,
        enabled: input.enabled,
        idpEntityId: input.idpEntityId,
        idpSsoUrl: input.idpSsoUrl,
        idpX509Cert: input.idpX509Cert,
        createdAt: now,
        updatedAt: now,
      };
      // ストアへ保存する
      store.ssoConfigs.set(id, created);
      // 作成した設定を返す
      return created;
    },

    // テナントの SSO 設定を削除する (tenantId スコープ)
    async delete(tenantId) {
      // tenantId が一致する設定を探して削除する
      for (const [id, cfg] of store.ssoConfigs.entries()) {
        // 一致したら Map から削除する
        if (cfg.tenantId === tenantId) store.ssoConfigs.delete(id);
      }
    },
  };
}
