// SAML アサーションのリプレイ防止記録リポジトリの契約 (port) と、メモリストア/ID 生成ヘルパーをインポート
import type { SamlAssertionRepository } from '@/data/ports/saml-assertion-repository';
import { nextId, type SamlAssertionRefRow, type Store } from './store';

// メモリストアを使った SamlAssertionRef リポジトリを生成する関数
export function makeSamlAssertionRepo(store: Store): SamlAssertionRepository {
  return {
    // (tenantId, assertionId) が初回利用なら記録して true、既に記録済み (リプレイ) なら false
    async recordIfNew({ tenantId, assertionId }) {
      // 既に同じ (tenantId, assertionId) が記録済みかを調べる (リプレイ検知)
      const alreadyUsed = Array.from(store.samlAssertionRefs.values()).some(
        (row) => row.tenantId === tenantId && row.assertionId === assertionId,
      );
      // 既に使用済みなら何も変更せず false を返す
      if (alreadyUsed) return false;
      // 新規行を組み立てる (ID と記録日時はここで決定)
      const row: SamlAssertionRefRow = {
        id: nextId(store, 'sar'), // 'sar_...' 形式の一意 ID
        assertionId, // SAML アサーション ID
        tenantId, // 所属テナント
        createdAt: new Date(), // 現在時刻 (= 初回使用日時)
      };
      // ストアに登録し、初回利用として true を返す
      store.samlAssertionRefs.set(row.id, row);
      return true;
    },
  };
}
